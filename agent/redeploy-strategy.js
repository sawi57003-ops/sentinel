// Sentinel strategy redeploy — Base mainnet, burn wallet only.
// The first deployed strategy used a Slipstream SwapRouter; that router
// serves a factory generation with NO AAPLc pool (live buy reverted
// "call to non-contract address"). The strategy now swaps directly against
// each token's verified pool, so redeploy + rewire + register pools.
// Usage: node redeploy-strategy.js
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const RPC = 'https://mainnet.base.org';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'deployment-mainnet.json'), 'utf8'));
  const pools = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aero-pools.json'), 'utf8'));
  const universe = dep.universe.map((u) => u.symbol);
  const provider = new ethers.JsonRpcProvider(RPC);
  const keystore = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', 'keystore.json'), 'utf8');
  const password = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', '.password'), 'utf8').trim();
  const signer = (await ethers.Wallet.fromEncryptedJson(keystore, password)).connect(provider);
  console.log('signer:', signer.address);

  const stratJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelStrategy.sol', 'SentinelStrategy.json'), 'utf8'));
  const vaultAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'SentinelVault.sol', 'SentinelVault.json'), 'utf8')).abi;
  const vault = new ethers.Contract(dep.contracts.SentinelVault, vaultAbi, signer);

  let spent = 0n;
  async function send(label, txPromise) {
    const tx = await txPromise;
    const r = await tx.wait();
    spent += r.gasUsed * r.gasPrice;
    console.log(`${label}: gas=${r.gasUsed} tx=${r.hash}`);
    return r;
  }

  const factory = new ethers.ContractFactory(stratJson.abi, stratJson.bytecode, signer);
  const strategy = await factory.deploy(USDC, dep.contracts.SentinelAuditor, dep.contracts.SentinelVault, dep.contracts.SentinelOracle, signer.address);
  const receipt = await strategy.deploymentTransaction().wait();
  spent += receipt.gasUsed * receipt.gasPrice;
  const addr = await strategy.getAddress();
  console.log(`SentinelStrategy (v2, direct-pool) deployed: ${addr} gas=${receipt.gasUsed} tx=${receipt.hash}`);

  await send('vault.setOperator (v2)', vault.setOperator(addr));
  await send('strategy.setPools (12)', strategy.setPools(
    universe.map((s) => pools[s].token),
    universe.map((s) => pools[s].pool)
  ));

  dep.contracts.SentinelStrategyV1Router = dep.contracts.SentinelStrategy;
  dep.contracts.SentinelStrategyV1RouterNote = 'v1 used Slipstream router 0xcbBb... — serves a factory generation with NO AAPLc pool; superseded, do not use';
  dep.contracts.SentinelStrategy = addr;
  dep.strategyV2DeployTx = receipt.hash;
  dep.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ROOT, 'data', 'deployment-mainnet.json'), JSON.stringify(dep, null, 2));
  console.log('TOTAL SPENT (ETH):', ethers.formatEther(spent));
}

main().catch((e) => { console.error('REDEPLOY FAILED:', e.message); process.exit(1); });
