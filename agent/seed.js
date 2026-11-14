// Sentinel seed — Base mainnet, burn wallet only.
// 1. Wrap 0.0015 ETH -> WETH, swap to USDC via Slipstream (deep WETH/USDC pool).
// 2. Deposit all USDC into the vault (agent's own seed).
// 3. Publish AAPLc verdict + buy $0.75 AAPLc (25% cap: vault ~$3.18, so $0.75 = 23.6%).
//    This is the first LIVE B20 trade — the proof the swap path works on real B20.
// Usage: node seed.js
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const RPC = 'https://mainnet.base.org';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ROUTER = '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D';
const AAPL_POOL = '0xF5FCB9CDAFcE67d50AfEf298F88E709d2B946BA6';
const AAPLC = '0xb200000000000000000000C2e324d24d7eEcd1fb';
const WRAP_ETH = ethers.parseEther('0.0015');
const BUY_USDC = 750000n; // $0.75

const ERC20_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];
const WETH_ABI = [...ERC20_ABI, 'function deposit() payable', 'function withdraw(uint256)'];
const ROUTER_ABI = ['function exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)'];
const POOL_ABI = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)'];

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'deployment-mainnet.json'), 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC);
  const keystore = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', 'keystore.json'), 'utf8');
  const password = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', '.password'), 'utf8').trim();
  const signer = (await ethers.Wallet.fromEncryptedJson(keystore, password)).connect(provider);
  console.log('signer:', signer.address);

  const vaultAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelVault.sol', 'SentinelVault.json'), 'utf8')).abi;
  const auditorAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelAuditor.sol', 'SentinelAuditor.json'), 'utf8')).abi;
  const strategyAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelStrategy.sol', 'SentinelStrategy.json'), 'utf8')).abi;
  const vault = new ethers.Contract(dep.contracts.SentinelVault, vaultAbi, signer);
  const auditor = new ethers.Contract(dep.contracts.SentinelAuditor, auditorAbi, signer);
  const strategy = new ethers.Contract(dep.contracts.SentinelStrategy, strategyAbi, signer);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, signer);
  const weth = new ethers.Contract(WETH, WETH_ABI, signer);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
  const pool = new ethers.Contract(AAPL_POOL, POOL_ABI, provider);

  let spent = 0n;
  async function send(label, txPromise) {
    const tx = await txPromise;
    const r = await tx.wait();
    spent += r.gasUsed * r.gasPrice;
    console.log(`${label}: gas=${r.gasUsed} tx=${r.hash}`);
    return r;
  }

  const alreadySeeded = (await vault.balanceOf(signer.address)) > 0n;
  if (!alreadySeeded) {
    // 1. Wrap ETH -> WETH (idempotent: top up only the shortfall — a previous
    //    run may already have wrapped).
    const wethBal0 = await weth.balanceOf(signer.address);
    if (wethBal0 < WRAP_ETH) {
      await send('wrap ETH->WETH', weth.deposit({ value: WRAP_ETH - wethBal0 }));
    } else {
      console.log('WETH already held:', ethers.formatEther(wethBal0));
    }
    // 2. Swap WETH -> USDC (expected ~$3.17 at ~$2,117/ETH; minOut $3.10)
    const allowance = await weth.allowance(signer.address, ROUTER);
    if (allowance < WRAP_ETH) {
      await send('approve router (WETH)', weth.approve(ROUTER, WRAP_ETH));
    }
    const swapParams = [WETH, USDC, 50, signer.address, Math.floor(Date.now() / 1000) + 600, WRAP_ETH, 3100000, 0];
    const swapOut = await router.exactInputSingle.staticCall(swapParams);
    console.log('quoted USDC out:', swapOut.toString());
    await send('swap WETH->USDC', router.exactInputSingle(swapParams));
    const usdcBal = await usdc.balanceOf(signer.address);
    console.log('USDC received:', usdcBal.toString(), `($${Number(usdcBal) / 1e6})`);
    if (usdcBal < 1000000n) throw new Error('seed too small');

    // 3. Deposit all USDC into the vault
    await send('approve vault (USDC)', usdc.approve(dep.contracts.SentinelVault, usdcBal));
    await send('vault.deposit (seed)', vault.deposit(usdcBal, signer.address));
    console.log('vault totalAssets:', (await vault.totalAssets()).toString());
    console.log('agent shares:', (await vault.balanceOf(signer.address)).toString());
  } else {
    console.log('already seeded — skipping wrap/swap/deposit, resuming at verdict/buy');
  }

  // 4. Verdict + first live B20 buy ($0.75 AAPLc)
  await send('auditor.publishVerdict AAPLc 85', auditor.publishVerdict(AAPLC, 85, true, ethers.keccak256(ethers.toUtf8Bytes('sentinel-audit-aaplc-2026-11-09'))));
  const slot0 = await pool.slot0();
  const sqrtP = slot0[0];
  // AAPL pool: token0=USDC (6dp), token1=AAPLc (8dp).
  // ratio=(sqrtP/2^96)^2 is AAPLc-per-USDC in raw units; human price:
  // USDC per AAPLc = 1 / (ratio * 10^(6-8)) = 100 / ratio.
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2;
  const price = 100 / ratio;
  console.log('AAPLc pool price: $', price.toFixed(2));
  const expectedOut = BigInt(Math.floor((Number(BUY_USDC) / 1e6 / price) * 1e8 * 0.99));
  const minOut = (expectedOut * 98n + 99n) / 100n; // ceil(98%) — floor() reverts the 2% band check
  console.log('buy $0.75 AAPLc expectedOut:', expectedOut.toString(), 'minOut:', minOut.toString());
  await send('strategy.buy AAPLc $0.75', strategy.buy(AAPLC, BUY_USDC, minOut, { gasLimit: 1500000 }));
  console.log('vault AAPLc balance:', (await new ethers.Contract(AAPLC, ERC20_ABI, provider).balanceOf(dep.contracts.SentinelVault)).toString());
  console.log('vault totalAssets:', (await vault.totalAssets()).toString());
  console.log('vault USDC balance:', (await usdc.balanceOf(dep.contracts.SentinelVault)).toString());
  console.log('TOTAL SEED GAS SPENT (ETH):', ethers.formatEther(spent));

  fs.writeFileSync(path.join(ROOT, 'data', 'seed.json'), JSON.stringify({
    seedShares: (await vault.balanceOf(signer.address)).toString(), buyUsdc: BUY_USDC.toString(), aaplPoolPrice: price,
    expectedOut: expectedOut.toString(), gasSpentEth: ethers.formatEther(spent),
    at: new Date().toISOString(),
  }, null, 2));
}

main().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
