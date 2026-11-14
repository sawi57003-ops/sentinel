// Sentinel UI — reads live from Base public RPC, no backend.
// Deposit/withdraw via the user's own MetaMask (ethers v6, ESM CDN).
import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@6.17.0/dist/ethers.min.js';

const C = window.SENTINEL_CONFIG;
const RPC = C.rpc;
const provider = new ethers.JsonRpcProvider(RPC);
const basescan = (tx) => `https://basescan.org/tx/${tx}`;
const $ = (id) => document.getElementById(id);

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const VAULT_ABI = [
  'function totalAssets() view returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)',
  'function deposit(uint256,address) returns (uint256)', 'function redeem(uint256,address,address) returns (uint256)',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
];
const AUDITOR_ABI = [
  'function getVerdict(address) view returns (tuple(uint8 score, bool passed, uint256 timestamp, bytes32 reportHash))',
  'event VerdictPublished(address indexed token, uint8 score, bool passed, uint256 timestamp, bytes32 reportHash)',
];
const STRATEGY_ABI = [
  'event Bought(address indexed token, uint256 usdcIn, uint256 tokenOut)',
  'event Sold(address indexed token, uint256 tokenIn, uint256 usdcOut)',
  'event EmergencyExit(address indexed token, uint256 tokenIn, uint256 usdcOut)',
];

const vault = new ethers.Contract(C.contracts.SentinelVault, VAULT_ABI, provider);
const auditor = new ethers.Contract(C.contracts.SentinelAuditor, AUDITOR_ABI, provider);

function fmtUsd(n) { return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function ago(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function loadVault() {
  const [assets, supply] = await Promise.all([vault.totalAssets(), vault.totalSupply()]);
  const tvl = Number(assets) / 1e6;
  $('tvl').textContent = fmtUsd(tvl);
  $('sharePrice').textContent = supply > 0n ? fmtUsd(Number(assets) / Number(supply)) : '—';
  // holdings
  const rows = [];
  let held = 0;
  for (const t of C.tokens) {
    const bal = await new ethers.Contract(t.token, ERC20_ABI, provider).balanceOf(C.contracts.SentinelVault);
    const units = Number(bal) / 1e8;
    if (units > 0) held++;
    rows.push({ ...t, units, value: units * t.navUsd });
  }
  $('holdingCount').textContent = `${held} / ${C.tokens.length}`;
  $('holdingsTable').querySelector('tbody').innerHTML = rows.map((r) => `<tr><td>${r.symbol}</td><td>${r.units.toFixed(6)}</td><td>${fmtUsd(r.value)}</td><td>${tvl ? (100 * r.value / tvl).toFixed(1) + '%' : '—'}</td><td><a href="https://basescan.org/address/${r.pool}" target="_blank">pool</a></td></tr>`).join('');
  // verdicts
  const vrows = [];
  for (const t of C.tokens) {
    const v = await auditor.getVerdict(t.token);
    vrows.push({ ...t, score: Number(v.score), passed: v.passed, ts: Number(v.timestamp), hash: v.reportHash });
  }
  $('verdictCount').textContent = `${vrows.filter((r) => r.passed).length} pass / ${vrows.length}`;
  $('auditTable').querySelector('tbody').innerHTML = vrows.map((r) => `<tr><td>${r.symbol}</td><td>${r.ts ? r.score : '—'}</td><td class="${r.passed ? 'pass' : 'fail'}">${r.ts ? (r.passed ? 'PASS' : 'FAIL') : 'no verdict yet'}</td><td>${r.ts ? ago(r.ts) : '—'}</td><td class="mono">${r.ts ? r.hash.slice(0, 18) + '…' : '—'}</td></tr>`).join('');
  $('contracts').innerHTML = Object.entries(C.contracts).map(([k, v]) => `${k}: <a href="https://basescan.org/address/${v}" target="_blank">${v}</a>`).join('<br>');
  $('agentAddr').textContent = C.agent;
  $('status').textContent = 'Live data loaded from Base.';
}

async function loadActivity() {
  const feed = $('activityFeed');
  try {
    const fromBlock = C.deployBlock;
    const [deposits, verdicts, buys, sells, exits] = await Promise.all([
      vault.queryFilter('Deposit', fromBlock), auditor.queryFilter('VerdictPublished', fromBlock),
      new ethers.Contract(C.contracts.SentinelStrategy, STRATEGY_ABI, provider).queryFilter('Bought', fromBlock),
      new ethers.Contract(C.contracts.SentinelStrategy, STRATEGY_ABI, provider).queryFilter('Sold', fromBlock),
      new ethers.Contract(C.contracts.SentinelStrategy, STRATEGY_ABI, provider).queryFilter('EmergencyExit', fromBlock),
    ]);
    const sym = Object.fromEntries(C.tokens.map((t) => [t.token.toLowerCase(), t.symbol]));
    const items = [];
    for (const e of deposits) items.push({ block: e.blockNumber, text: `Deposit ${fmtUsd(Number(e.args.assets) / 1e6)} by ${e.args.owner.slice(0, 10)}…`, tx: e.transactionHash });
    for (const e of verdicts) items.push({ block: e.blockNumber, text: `Audit verdict ${sym[e.args.token.toLowerCase()] || e.args.token.slice(0, 10)}: score ${e.args.score} ${e.args.passed ? 'PASS' : 'FAIL'}`, tx: e.transactionHash });
    for (const e of buys) items.push({ block: e.blockNumber, text: `Agent bought ${sym[e.args.token.toLowerCase()] || 'B20'} for ${fmtUsd(Number(e.args.usdcIn) / 1e6)}`, tx: e.transactionHash });
    for (const e of sells) items.push({ block: e.blockNumber, text: `Agent sold ${sym[e.args.token.toLowerCase()] || 'B20'} for ${fmtUsd(Number(e.args.usdcOut) / 1e6)}`, tx: e.transactionHash });
    for (const e of exits) items.push({ block: e.blockNumber, text: `⚠️ Emergency exit ${sym[e.args.token.toLowerCase()] || 'B20'} → ${fmtUsd(Number(e.args.usdcOut) / 1e6)}`, tx: e.transactionHash });
    items.sort((a, b) => b.block - a.block);
    feed.innerHTML = items.slice(0, 50).map((i) => `<li>${i.text} — <a href="${basescan(i.tx)}" target="_blank">#${i.block}</a></li>`).join('') || '<li>No activity yet.</li>';
  } catch (e) {
    feed.innerHTML = `<li>Activity feed unavailable (${e.message.slice(0, 120)}). See contracts on Basescan.</li>`;
  }
}

// --- wallet actions ---
let signer = null;
$('connectBtn').onclick = async () => {
  if (!window.ethereum) { $('status').textContent = 'No MetaMask detected.'; return; }
  const web3 = new ethers.BrowserProvider(window.ethereum);
  await web3.send('eth_requestAccounts', []);
  const net = await web3.getNetwork();
  if (Number(net.chainId) !== 8453) {
    try { await web3.send('wallet_switchEthereumChain', [{ chainId: '0x2105' }]); }
    catch { $('status').textContent = 'Please switch MetaMask to Base (chain 8453).'; return; }
  }
  signer = await web3.getSigner();
  $('walletAddr').textContent = await signer.getAddress();
  $('depositBtn').disabled = false;
  $('withdrawBtn').disabled = false;
  $('status').textContent = 'Connected to Base.';
};
$('depositBtn').onclick = async () => {
  const amt = parseFloat($('amountInput').value);
  if (!amt || amt < 1 || amt > 100) { $('status').textContent = 'Amount must be $1–$100.'; return; }
  const usdc = new ethers.Contract(C.usdc, ERC20_ABI, signer);
  const v = new ethers.Contract(C.contracts.SentinelVault, VAULT_ABI, signer);
  const raw = BigInt(Math.round(amt * 1e6));
  $('status').textContent = 'Approving USDC…';
  await (await usdc.approve(C.contracts.SentinelVault, raw)).wait();
  $('status').textContent = 'Depositing…';
  const tx = await v.deposit(raw, await signer.getAddress());
  $('status').innerHTML = `Deposit sent: <a href="${basescan(tx.hash)}" target="_blank">${tx.hash.slice(0, 18)}…</a>`;
  await tx.wait();
  loadVault();
};
$('withdrawBtn').onclick = async () => {
  const v = new ethers.Contract(C.contracts.SentinelVault, VAULT_ABI, signer);
  const shares = await v.balanceOf(await signer.getAddress());
  if (shares === 0n) { $('status').textContent = 'No shares to withdraw.'; return; }
  $('status').textContent = 'Withdrawing…';
  const tx = await v.redeem(shares, await signer.getAddress(), await signer.getAddress());
  $('status').innerHTML = `Withdraw sent: <a href="${basescan(tx.hash)}" target="_blank">${tx.hash.slice(0, 18)}…</a>`;
  await tx.wait();
  loadVault();
};

loadVault().catch((e) => { $('status').textContent = 'Failed to load vault data: ' + e.message.slice(0, 160); });
loadActivity();
