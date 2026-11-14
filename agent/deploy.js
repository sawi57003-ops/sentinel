// Sentinel mainnet deploy — Base (chain 8453), burn wallet only.
// Usage: node deploy.js [--dry-run]
// Reads the burn keystore + password from disk; NEVER prints either.
// Aborts if total deployment spend would exceed 0.001 ETH.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const RPC = 'https://mainnet.base.org';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// NOTE: no router — SentinelStrategy swaps directly against each token's
// verified Slipstream pool (see SentinelStrategy.sol for why routers were dropped).
const MAX_DEPLOY_SPEND_ETH = 0.001;

const DRY_RUN = process.argv.includes('--dry-run');

function artifact(name) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode };
}

async function main() {
  const pools = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aero-pools.json'), 'utf8'));
  const b20 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'b20-list.json'), 'utf8'));
  const bySym = Object.fromEntries(b20.map((r) => [r.symbol, r]));
  const universe = ['AAPLc', 'NVDAc', 'TSLAc', 'MSFTc', 'METAc', 'GOOGLc', 'AMZNc', 'CRCLc', 'INTCc', 'MSTRc', 'SNDKc', 'SPCXc'];

  const provider = new ethers.JsonRpcProvider(RPC);
  const keystore = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', 'keystore.json'), 'utf8');
  const password = fs.readFileSync(path.join(process.env.HOME, '.wallets', 'burn', '.password'), 'utf8').trim();
  const wallet = await ethers.Wallet.fromEncryptedJson(keystore, password);
  const signer = wallet.connect(provider);
  console.log('deployer:', signer.address);
  const bal = await provider.getBalance(signer.address);
  console.log('ETH balance:', ethers.formatEther(bal));
  const fee = await provider.getFeeData();
  console.log('gas price (gwei):', ethers.formatUnits(fee.gasPrice, 'gwei'));

  if (DRY_RUN) {
    console.log('DRY RUN — estimating deployment gas only, sending nothing.');
    let totalGas = 0n;
    for (const name of ['SentinelOracle', 'SentinelAuditor', 'SentinelVault', 'SentinelStrategy']) {
      const { abi, bytecode } = artifact(name);
      const factory = new ethers.ContractFactory(abi, bytecode, signer);
      const tx = await factory.getDeployTransaction(
        ...(name === 'SentinelOracle' ? [signer.address]
          : name === 'SentinelAuditor' ? [signer.address]
          : name === 'SentinelVault' ? [USDC, ethers.ZeroAddress, signer.address]
          : [USDC, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ROUTER, signer.address])
      );
      // Placeholder addresses for estimation; real deploy below uses real args.
      const gas = await provider.estimateGas({ ...tx, from: signer.address });
      console.log(name, 'est. gas:', gas.toString());
      totalGas += gas;
    }
    const cost = totalGas * fee.gasPrice;
    console.log('total est. deploy cost (ETH):', ethers.formatEther(cost));
    console.log(cost > ethers.parseEther(String(MAX_DEPLOY_SPEND_ETH)) ? 'WOULD EXCEED BUDGET — abort' : 'within budget');
    return;
  }

  let spent = 0n;
  async function deploy(name, ...args) {
    const { abi, bytecode } = artifact(name);
    const factory = new ethers.ContractFactory(abi, bytecode, signer);
    const contract = await factory.deploy(...args);
    const receipt = await contract.deploymentTransaction().wait();
    const cost = receipt.gasUsed * receipt.gasPrice;
    spent += cost;
    console.log(`${name} deployed: ${await contract.getAddress()} gas=${receipt.gasUsed} cost=${ethers.formatEther(cost)} ETH tx=${receipt.hash}`);
    if (spent > ethers.parseEther(String(MAX_DEPLOY_SPEND_ETH))) throw new Error('deploy spend exceeded budget — aborting');
    return contract;
  }

  const oracle = await deploy('SentinelOracle', signer.address);
  const auditor = await deploy('SentinelAuditor', signer.address);
  const vault = await deploy('SentinelVault', USDC, await oracle.getAddress(), signer.address);
  const strategy = await deploy(
    'SentinelStrategy', USDC, await auditor.getAddress(), await vault.getAddress(),
    await oracle.getAddress(), signer.address
  );

  async function send(label, txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const cost = receipt.gasUsed * receipt.gasPrice;
    spent += cost;
    console.log(`${label}: gas=${receipt.gasUsed} cost=${ethers.formatEther(cost)} ETH tx=${receipt.hash}`);
  }

  await send('vault.setOperator', vault.setOperator(await strategy.getAddress()));
  for (const sym of universe) {
    await send(`vault.addHolding ${sym}`, vault.addHolding(pools[sym].token));
  }
  await send(
    'strategy.setPools',
    strategy.setPools(universe.map((s) => pools[s].token), universe.map((s) => pools[s].pool))
  );
  const prices = universe.map((s) => {
    const nav = bySym[s].nav_price;
    if (nav == null) throw new Error(`no NAV for ${s}`);
    return BigInt(Math.round(nav * 1e8));
  });
  await send(
    'oracle.setPrices',
    oracle.setPrices(universe.map((s) => pools[s].token), prices)
  );

  const out = {
    chain: 'base',
    chainId: 8453,
    deployer: signer.address,
    usdc: USDC,
    contracts: {
      SentinelOracle: await oracle.getAddress(),
      SentinelAuditor: await auditor.getAddress(),
      SentinelVault: await vault.getAddress(),
      SentinelStrategy: await strategy.getAddress(),
    },
    universe: universe.map((s) => ({ symbol: s, token: pools[s].token, pool: pools[s].pool, tickSpacing: 10, navUsd: bySym[s].nav_price })),
    totalDeploySpendEth: ethers.formatEther(spent),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'deployment-mainnet.json'), JSON.stringify(out, null, 2));
  console.log('TOTAL SPENT (ETH):', ethers.formatEther(spent));
  console.log('saved data/deployment-mainnet.json');
}

main().catch((e) => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
