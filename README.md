# Sentinel — AI-Audited B20 Index Vault

**Base Stocks Maxxing Season hackathon (5 Nov – 5 Dec 2026), Agentic Stock
Finance track.** A public index vault for Coinbase B20 tokenized stocks on
Base, managed entirely by an AI agent. The agent audits each B20 token,
publishes a pass/fail verdict on-chain, and the vault invests its USDC only
in tokens that pass — equal-weighted, rebalanced on drift.

> Experimental demo — not financial advice. Tokenized stocks are issued
> under Regulation S and are not offered to U.S. persons; this demo does not
> target U.S. users and confers no rights in any underlying company.
> Contracts are unaudited; TVL is capped at $500.

## What it is

| Piece | What it does |
|---|---|
| `SentinelVault` | ERC-4626 USDC vault. Deposit USDC (min $1, max $100/deposit, $500 TVL cap), withdraw anytime. `totalAssets()` = USDC + B20 holdings at oracle prices. Pausable. |
| `SentinelAuditor` | On-chain verdict registry. Agent-only `publishVerdict` / batch; `isApproved` = fresh (≤7d) PASS (score ≥ 70). A failed token can never be bought. |
| `SentinelStrategy` | Agent-only executor. Buys/sells B20 by swapping **directly against each token's verified Slipstream pool** (`pool.swap()` + `uniswapV3SwapCallback`) — no router (see VERIFICATION.md §4 for why). Enforces the 25%-per-holding cap and a `minOut` slippage floor on every trade. `emergencyExit` sells a newly-failed token immediately. |
| `SentinelOracle` | Agent-updated USD prices (8dp, from the official Coinbase API NAV). Prices older than 48h are stale and value holdings at 0. |
| Agent loop (`agent/loop.js`) | Every 6h (audit daily): scores all 12 tokens 0–100 from the official API + Dexscreener + on-chain slot0, publishes verdicts, updates oracle prices, rebalances only on >5% drift or a new FAIL. Dry-run by default; `--live` sends txs. |
| UI (`ui/`) | Static page (no build step): TVL/holdings, audit table, agent activity feed (Basescan-linked), deposit/withdraw via MetaMask. |

## Contracts — Base mainnet (chain 8453)

| Contract | Address |
|---|---|
| SentinelOracle | `0x4825599E54C18a64F3Ea3241f447A3801c0cfB76` |
| SentinelAuditor | `0x46E341A0a0e934d12aAf886125F03b6914D75388` |
| SentinelVault | `0x7469E23D2Fc7CDFe0cfAAA0746Da225411ba63c9` |
| SentinelStrategy (v2, direct-pool) | `0x14EEa452237427Cf5E3072bBB2A8526c8406d909` |

Deployer/agent wallet (burn wallet): `0x41102aD3c29FF70E457B25CeAc0F120a1ed7B337`.
Universe (12, all verified against the official API — COINc is not listed
there and was dropped): AAPLc, NVDAc, TSLAc, MSFTc, METAc, GOOGLc, AMZNc,
CRCLc, INTCc, MSTRc, SNDKc, SPCXc. Full addresses + pools in
`data/deployment-mainnet.json` and `data/aero-pools.json`.
Basescan source verification is **pending** (no API key in this environment).

## Current state (2026-11-09, verified on-chain)

- Vault seeded with the agent's own **$3.18 USDC** (0.0015 ETH; the wallet's
  0.0023 ETH was ~$4.87 at $2,117/ETH, so $5 was not affordable).
- Vault holds **all 12 B20 tokens ≈ $0.26 each**, totalAssets **$3.17**.
- Agent verdicts published on-chain for all 12 (10× score 100, CRCLc 80,
  INTCc 85–95 — all PASS).
- Gas spent to date: **~0.000176 ETH (~$0.37)** including all failed
  attempts. Burn wallet balance left: ~0.000625 ETH (~$1.32) — enough for
  ~100 more agent txs at current gas prices.
- First live B20 trade: $0.75 AAPLc buy, tx
  `0x63e09430125c5d7d534dbe92acc97e9029505c1913565d55ec50b384ca98aa8d`.

## How to run

```bash
# tests (unit + Base fork; needs network for the fork tests)
cd contracts && forge test

# agent loop — dry run (default, sends nothing)
cd agent && node loop.js --dry-run
# agent loop — live (publishes verdicts, updates prices, rebalances)
node loop.js --live

# one-off scripts
node deploy.js --dry-run   # estimate deployment gas (fresh deploy)
node deploy.js              # deploy all contracts + configure
node seed.js                # wrap ETH -> USDC -> deposit + first AAPLc buy
```

Schedule (suggested, not yet installed as a cron — see below):
`loop.js --live` every 6h; the daily run publishes the verdict batch
(1 tx/day) and rebalances only when triggered (expected 2–3 txs/week).

## How traction is measured

- **Agent txs**: verdict batches (1/day), oracle updates, rebalances,
  emergency exits — all visible in the UI activity feed and on Basescan.
  Target ~60–90 txs by Dec 5.
- **User deposits**: `Deposit` events on the vault; target 20+ unique
  depositors. TVL is tracked by `totalAssets()` on the UI.
- **No vanity metrics**: every number on the UI links to its Basescan tx
  or event. Demo caps: $500 TVL, $100/deposit, $1 minimum.

## Design deviations (vs DESIGN.md, all verified, see VERIFICATION.md)

1. **No router.** The documented Slipstream routers each serve one factory
   generation; none serves the factory holding the deep B20 pools. The
   strategy swaps directly against verified pools. A v1 router-based
   strategy was deployed and superseded after its live buy reverted.
2. **Oracle instead of in-vault TWAP.** `totalAssets()` uses agent-updated
   NAV prices; the TWAP/deviation check lives in the audit score
   (DEX price vs NAV <2% = full points).
3. **Seed $3.18, not $5.** ETH was ~$2,117, so 0.0023 ETH ≈ $4.87 total.
4. **Base Sepolia deployment skipped** — both wallets hold 0 testnet ETH
   and public faucets need accounts. Fork tests are the E2E evidence.
5. **Pool-hook gas rule.** Strategy swaps must be sent with an explicit
   1,500,000 gas limit — the pools' `DynamicSwapFeeHook` requires
   `gasleft() > 250,000` at its `afterSwap` checkpoint (`'IG'`), and
   ethers' estimate is too low. This cost 13 failed live attempts to find.

## What is left before submission (DO NOT do without Bre's approval)

1. **Basescan source verification** of the 4 contracts (needs a Basescan
   API key, or manual verification in the Basescan UI).
2. **Install the agent-loop schedule** (cron, `loop.js --live` every 6h)
   — currently the loop is run manually; do NOT leave it running
   unattended with real funds beyond the seeded ~$3.18 without a
   separate go-ahead.
3. **Traction push**: daily verdicts, invite deposits, build-in-public
   posts (the 25% build-in-public score).
4. **Submission (Bre only)**: public X post with video demo tagging
   @buildonbase + the Google submission form. Deadline **Dec 5, 2026**
   — submit well before end of day (form says 11:59pm EST; rules say UTC).
5. **Optional**: Base Sepolia deployment if testnet ETH becomes available.

## Repo layout

```
contracts/         Foundry project (src/*.sol, test/*.sol)
agent/             deploy.js, seed.js, redeploy-strategy.js, loop.js, reports/
ui/                index.html, app.js, config.js (static, no build step)
data/              b20-list.json, aero-pools.json, deployment-mainnet.json, seed.json
RESEARCH.md        hackathon research (official rules, tracks, judging)
DESIGN.md          original design doc
VERIFICATION.md    every verification step + evidence + open risks
```
