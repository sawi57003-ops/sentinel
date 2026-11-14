// Sentinel agent loop — Base mainnet, burn wallet only.
// Every 6h (audit daily): score each B20 token, publish verdicts on-chain,
// update oracle prices, rebalance only on >5% drift or a new FAIL.
//   node loop.js --dry-run   (default: prints the plan, sends nothing)
//   node loop.js --live      (sends txs; requires the burn keystore)
// Safety: dry-run is the default; --live still caps each buy at 25% of TVL
// (enforced on-chain too) and never trades a token without a fresh PASS.
// No funds beyond the seeded ~$3.18 are ever added by this script.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const RPC = 'https://mainnet.base.org';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DRIFT_BPS = 500; // rebalance when a holding is >5% off target
const MAX_TRADE_USDC = 100_000000; // $100 per trade (hard cap; vault TVL cap is $500 anyway)

const POOL_ABI = [
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

const LIVE = process.argv.includes('--live');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scoreToken(t) {
  // t: {api, dex, poolPrice} — deterministic checklist, 0-100, pass >= 70.
  let score = 0;
  const why = [];
  if (t.api) { score += 20; why.push('api-listed+20'); } else { why.push('NOT in official API+0'); return { score, why }; }
  const mult = Number(t.api.multiplier ?? 1);
  if (mult > 0.95 && mult < 1.05) { score += 10; why.push('multiplier sane+10'); } else why.push('multiplier odd+0');
  const liq = t.dex?.liqUsd ?? 0;
  if (liq > 100000) { score += 20; why.push(`liq $${Math.round(liq)}+20`); }
  else if (liq > 10000) { score += 15; why.push(`liq $${Math.round(liq)}+15`); }
  else if (liq > 1000) { score += 10; why.push(`liq $${Math.round(liq)}+10`); }
  else why.push(`liq $${Math.round(liq)}+0`);
  const vol = t.dex?.vol24Usd ?? 0;
  if (vol > 100000) { score += 10; why.push(`vol24 $${Math.round(vol)}+10`); }
  else if (vol > 10000) { score += 5; why.push(`vol24 $${Math.round(vol)}+5`); }
  else why.push(`vol24 $${Math.round(vol)}+0`);
  if (t.api.nav_price != null && t.poolPrice != null) {
    const dev = Math.abs(t.poolPrice - t.api.nav_price) / t.api.nav_price;
    if (dev < 0.02) { score += 20; why.push(`price dev ${(dev * 100).toFixed(2)}%+20`); }
    else if (dev < 0.05) { score += 10; why.push(`price dev ${(dev * 100).toFixed(2)}%+10`); }
    else why.push(`price dev ${(dev * 100).toFixed(2)}%+0`);
    score += 10; why.push('NAV present+10');
  } else why.push('no NAV/pool price+0');
  if ((t.api.total_supply ?? 0) > 0) { score += 10; why.push('supply>0+10'); }
  else why.push('supply 0/missing+0');
  return { score, why };
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'deployment-mainnet.json'), 'utf8'));
  const pools = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aero-pools.json'), 'utf8'));
  const universe = dep.universe.map((u) => u.symbol);
  const provider = new ethers.JsonRpcProvider(RPC);

  // --- 1. READ: official API + Dexscreener + on-chain slot0 ---
  const api = await (await fetch('https://api.coinbase.com/v1/tokenized-stocks?page_size=500')).json();
  const apiBySym = Object.fromEntries((api.tokens || []).map((t) => [t.symbol, t]));
  const results = [];
  for (const sym of universe) {
    const token = pools[sym].token;
    const pool = new ethers.Contract(pools[sym].pool, POOL_ABI, provider);
    let poolPrice = null;
    try {
      const slot0 = await pool.slot0();
      const ratio = (Number(slot0[0]) / 2 ** 96) ** 2;
      poolPrice = 100 / ratio; // token0=USDC (6dp), token1=B20 (8dp): USDC per token
    } catch (e) { console.log(sym, 'slot0 read failed:', e.message); }
    let dex = null;
    try {
      const d = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`)).json();
      const p = (d.pairs || []).find((x) => x.chainId === 'base' && x.dexId === 'aero' && x.quoteToken?.symbol === 'USDC' && x.pairAddress.toLowerCase() === pools[sym].pool.toLowerCase());
      if (p) dex = { liqUsd: Number(p.liquidity?.usd || 0), vol24Usd: Number(p.volume?.h24 || 0), priceUsd: Number(p.priceUsd || 0) };
    } catch (e) { console.log(sym, 'dexscreener failed:', e.message); }
    const { score, why } = scoreToken({ api: apiBySym[sym], dex, poolPrice });
    results.push({ sym, token, pool: pools[sym].pool, score, passed: score >= 70, why, nav: apiBySym[sym]?.nav_price ?? null, poolPrice, liqUsd: dex?.liqUsd ?? 0 });
    await sleep(250); // public RPC limit is 25 req/s — stay well under it
  }

  console.log('=== Sentinel audit', new Date().toISOString(), LIVE ? '(LIVE)' : '(DRY RUN) ===');
  for (const r of results) {
    console.log(`${r.sym.padEnd(6)} score=${String(r.score).padStart(3)} ${r.passed ? 'PASS' : 'FAIL'}  NAV=${r.nav} pool=$${r.poolPrice?.toFixed(2)} liq=$${Math.round(r.liqUsd)}  [${r.why.join(', ')}]`);
  }

  // --- 2. READ vault state ---
  const vaultAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelVault.sol', 'SentinelVault.json'), 'utf8')).abi;
  const auditorAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelAuditor.sol', 'SentinelAuditor.json'), 'utf8')).abi;
  const strategyAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelStrategy.sol', 'SentinelStrategy.json'), 'utf8')).abi;
  const oracleAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelOracle.sol', 'SentinelOracle.json'), 'utf8')).abi;
  const vault = new ethers.Contract(dep.contracts.SentinelVault, vaultAbi, provider);
  const auditor = new ethers.Contract(dep.contracts.SentinelAuditor, auditorAbi, provider);
  const totalAssets = Number(await vault.totalAssets()) / 1e6;
  console.log(`vault totalAssets: $${totalAssets.toFixed(2)}`);
  const passers = results.filter((r) => r.passed);
  const targetEach = passers.length ? totalAssets / passers.length : 0;
  console.log(`passers: ${passers.length}/${results.length} — equal-weight target $${targetEach.toFixed(2)} each (cap 25% = $${(totalAssets * 0.25).toFixed(2)})`);

  // holdings values (oracle prices)
  const actions = [];
  for (const r of results) {
    const bal = Number(await new ethers.Contract(r.token, ERC20_ABI, provider).balanceOf(dep.contracts.SentinelVault)) / 1e8;
    const value = bal * (r.nav ?? r.poolPrice ?? 0);
    const verdict = await auditor.getVerdict(r.token);
    const wasPass = verdict.passed && (Date.now() / 1000 - Number(verdict.timestamp)) < 7 * 86400;
    if (!r.passed && bal > 0) {
      actions.push({ type: 'EMERGENCY_EXIT', sym: r.sym, token: r.token, amount: bal, minOutUsd: value * 0.95 });
      console.log(`ACTION: EMERGENCY_EXIT ${r.sym} (new FAIL, holds ${bal} = $${value.toFixed(2)})`);
    } else if (r.passed && Math.abs(value - targetEach) / Math.max(targetEach, 0.01) > DRIFT_BPS / 10000 && totalAssets > 1) {
      if (value > targetEach) actions.push({ type: 'SELL', sym: r.sym, token: r.token, usd: value - targetEach });
      else actions.push({ type: 'BUY', sym: r.sym, token: r.token, usd: Math.min(targetEach - value, MAX_TRADE_USDC / 1e6, totalAssets * 0.25) });
      console.log(`ACTION: ${value > targetEach ? 'SELL' : 'BUY'} ${r.sym} $${Math.abs(value - targetEach).toFixed(2)} (holds $${value.toFixed(2)} vs target $${targetEach.toFixed(2)})`);
    }
    if (wasPass !== r.passed) console.log(`NOTE: ${r.sym} verdict flips ${wasPass ? 'PASS->FAIL' : 'FAIL->PASS'}`);
    await sleep(250);
  }
  if (!actions.length) console.log('no rebalance needed (drift <= 5%, no new fails)');

  // --- 3. report file (always written, even in dry-run) ---
  const reportDir = path.join(ROOT, 'agent', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { at: new Date().toISOString(), live: LIVE, totalAssetsUsd: totalAssets, results, actions };
  fs.writeFileSync(path.join(reportDir, `${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(report, null, 2));

  if (!LIVE) { console.log('DRY RUN — no transactions sent. Re-run with --live to publish verdicts + rebalance.'); return; }

  // --- 4. LIVE: publish verdicts, update oracle, execute actions ---
  const keystore = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', 'keystore.json'), 'utf8');
  const password = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', '.password'), 'utf8').trim();
  const signer = (await ethers.Wallet.fromEncryptedJson(keystore, password)).connect(provider);
  const auditorS = new ethers.Contract(dep.contracts.SentinelAuditor, auditorAbi, signer);
  const oracleS = new ethers.Contract(dep.contracts.SentinelOracle, oracleAbi, signer);
  const strategyS = new ethers.Contract(dep.contracts.SentinelStrategy, strategyAbi, signer);
  let spent = 0n;
  async function send(label, p) {
    const tx = await p;
    const r = await tx.wait();
    spent += r.gasUsed * r.gasPrice;
    console.log(`${label}: tx=${r.hash} gas=${r.gasUsed}`);
    return r;
  }
  // The pools' DynamicSwapFeeHook requires gasleft() > 250,000 at its
  // afterSwap checkpoint ('IG' = insufficient gas for the tape record).
  // ethers' gas estimate is too low for that check, so strategy swaps get
  // an explicit generous limit (only gas actually used is paid).
  const SWAP_GAS_LIMIT = 1500000;
  const reportHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(results.map((r) => [r.sym, r.score]))));
  await send('publishVerdictBatch (12)', auditorS.publishVerdictBatch(
    results.map((r) => r.token), results.map((r) => r.score), results.map((r) => r.passed),
    results.map(() => reportHash)
  ));
  await send('oracle.setPrices (12)', oracleS.setPrices(
    results.map((r) => r.token),
    results.map((r) => BigInt(Math.round((r.nav ?? r.poolPrice ?? 0) * 1e8)))
  ));
  // --- USDC cash tracking (fix for run #5: BUY MSTRc/SNDKc reverted on empty vault) ---
  // Vault is structurally cash-poor (totalAssets ~$3.22, USDC cash ~$0.015);
  // USDC only enters via SELL/EMERGENCY_EXIT. Execute those first, then track
  // remaining USDC across actions so a later BUY never exceeds the cash on hand.
  const usdcContract = new ethers.Contract(USDC, ERC20_ABI, provider);
  let usdcCash = await usdcContract.balanceOf(dep.contracts.SentinelVault);
  console.log(`vault USDC cash: $${(Number(usdcCash) / 1e6).toFixed(4)}`);
  // SELLs + EMERGENCY_EXITs first (they fund the vault), BUYs after.
  const orderedActions = [
    ...actions.filter((a) => a.type !== 'BUY'),
    ...actions.filter((a) => a.type === 'BUY'),
  ];
  if (orderedActions.length !== actions.length) console.log('execution order: sells/exits first, then buys');
  for (const a of orderedActions) {
    // One retry: a pool-hook revert ('IG' seen once on NVDAc) can be
    // transient/state-dependent, so re-quote fresh and retry once before
    // giving up on that token (never let one bad pool block the rest).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const pool = new ethers.Contract(pools[a.sym].pool, POOL_ABI, provider);
        const slot0 = await pool.slot0();
        const ratio = (Number(slot0[0]) / 2 ** 96) ** 2;
        const price = 100 / ratio;
        if (a.type === 'EMERGENCY_EXIT') {
          const balRaw = await new ethers.Contract(a.token, ERC20_ABI, provider).balanceOf(dep.contracts.SentinelVault);
          const minOut = BigInt(Math.floor(Number(balRaw) / 1e8 * price * 0.95 * 1e6));
          await send(`emergencyExit ${a.sym}`, strategyS.emergencyExit(a.token, minOut, { gasLimit: SWAP_GAS_LIMIT }));
          usdcCash += minOut; // proceeds fund later BUYs (minOut = safe lower bound)
        } else if (a.type === 'SELL') {
          const usd = a.usd;
          const tokRaw = BigInt(Math.floor((usd / price) * 1e8 * 0.99));
          const minOut = BigInt(Math.floor(usd * 0.98 * 1e6));
          await send(`sell ${a.sym} $${usd.toFixed(2)}`, strategyS.sell(a.token, tokRaw, minOut, { gasLimit: SWAP_GAS_LIMIT }));
          usdcCash += minOut; // proceeds fund later BUYs (minOut = safe lower bound)
        } else {
          // BUY: cap by remaining USDC cash; skip if only dust is left.
          let usd = a.usd;
          let usdcRaw = BigInt(Math.floor(usd * 1e6));
          if (usdcRaw > usdcCash) {
            if (usdcCash < 5000n) { // < $0.005 — dust, not worth a swap
              console.log(`SKIP buy ${a.sym} $${usd.toFixed(2)} — vault USDC cash $${(Number(usdcCash) / 1e6).toFixed(4)} insufficient`);
              break; // skip this action (no retry — cash won't appear mid-run; sells already ran)
            }
            usd = Number(usdcCash) / 1e6;
            usdcRaw = usdcCash;
            console.log(`SHRINK buy ${a.sym} to $${usd.toFixed(4)} (vault USDC cash limit)`);
          }
          const expectedOut = BigInt(Math.floor((usd / price) * 1e8 * 0.99));
          const minOut = (expectedOut * 98n + 99n) / 100n;
          await send(`buy ${a.sym} $${usd.toFixed(2)}`, strategyS.buy(a.token, usdcRaw, minOut, { gasLimit: SWAP_GAS_LIMIT }));
          usdcCash -= usdcRaw;
        }
        break; // success — next action
      } catch (e) {
        console.log(`${a.type} ${a.sym} attempt ${attempt + 1} FAILED: ${e.message?.slice(0, 200)}`);
        if (attempt === 1) console.log(`GIVING UP on ${a.sym} this run — will retry next cycle`);
        else await sleep(2000);
      }
    }
  }
  console.log('LIVE RUN DONE. gas spent (ETH):', ethers.formatEther(spent));
}

main().catch((e) => { console.error('LOOP FAILED:', e.message); process.exit(1); });
