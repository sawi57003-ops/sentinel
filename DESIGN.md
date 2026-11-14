# Sentinel — AI-Audited B20 Index Vault

**Project:** one submission for Base Stocks Maxxing Season, Agentic Stock Finance track
**Hackathon:** 5 Nov – 5 Dec 2026, $100,000+ pool. Judging: 50% real onchain traction, 25% product quality, 25% build in public. No token launch required.
**Builder:** an AI agent (Muse / 王林) that writes Solidity, runs Foundry tests, and operates an off-chain agent loop.
**Deployer wallet (burn wallet, Base):** `0x41102aD3c29FF70E457B25CeAc0F120a1ed7B337`, ~0.0023 ETH. Gas budget is a few dollars max.
**Status:** design only — no contracts deployed, no B20 addresses hardcoded yet (see §5).

## 1. The idea

**Sentinel is a public index vault for Coinbase B20 tokenized stocks on Base, managed entirely by an AI agent — not a human.** The agent audits every B20 token (AAPL, NVDA, TSLA, MSFT, META, GOOGL, AMZN, COIN, CRCL, INTC, MSTR, SNDK, SPCX), publishes a pass/fail verdict for each one on-chain, and autonomously invests the vault's USDC only in the tokens that pass — equal-weighted, rebalanced when weights drift. Users deposit USDC (min $1) and receive vault shares; they can withdraw any time. Every audit verdict, rebalance, and deposit is a real Base transaction, so the agent's work *is* the traction.

Why it fits Agentic Stock Finance: the program, not a human, is the fund manager — it reads on-chain prices and contract state, judges the assets, and executes the trades. It also plays to this builder's actual edge: an agent that writes and audits Solidity is the credible party to run an *audited-only* stock index. No other entrant's pitch is "the manager is an auditor."

## 2. How it works end-to-end

### On-chain contracts (Base, chain 8453) — three contracts, all Foundry-tested on a Base fork first

| Contract | Purpose | Key functions (2–3 each) |
|---|---|---|
| `SentinelVault.sol` | ERC-4626 USDC vault. Holds USDC + B20 tokens, issues shares. | `deposit(uint256 assets, address receiver)` — mint shares for USDC. `withdraw(uint256 shares, address receiver, address owner)` — redeem shares for USDC value. `totalAssets()` — USDC + mark-to-market value of B20 holdings (DEX TWAP). |
| `SentinelAuditor.sol` | On-chain audit registry. The agent's verdicts, permanently verifiable. | `publishVerdict(address token, uint8 score, bool passed, bytes32 reportHash)` — agent-only, batched per cycle. `getVerdict(address token)` — latest score / pass / timestamp / report hash. `isApproved(address token)` — read by the strategy contract; a failed token can never be bought. |
| `SentinelStrategy.sol` | Holds the allowlist + target weights and executes swaps. Only the agent (burn wallet) can call it. | `rebalance(address[] calldata tokens, uint256[] calldata weightsBps)` — sells overweight / buys underweight via the DEX router, only for `isApproved` tokens, with a max-slippage + TWAP-deviation check that reverts the whole call if breached. `emergencyExit(address token)` — sells a token to USDC in one call the moment its audit fails. `setRouter(address)` — swap the DEX adapter without redeploying the vault. |

Swap venue is an adapter interface (`ISwapRouter`), implemented first for Aerodrome Slipstream (where B20/USDC pools live) with Uniswap V3 as the fallback. The vault never mints or redeems B20 tokens — it only trades them on secondary DEX markets, which is permissionless.

### Off-chain agent loop (Node script + cron, runs on the VM)

Cycle every **6 hours**; audit refresh once **daily**; rebalance only when triggered.

1. **Read (free sources only):** each B20 token's `multiplier()`, decimals (8), and balances; Aerodrome pool reserves + TWAP and Uniswap V3 `QuoterV2`; Chainlink B20 feed price + age (free on-chain read); Basescan free API for source-verification status.
2. **Audit (deterministic checklist + agent judgement):** source verified? ERC-20 interface intact? `multiplier()` sane vs last cycle? Pool liquidity above floor (e.g. >$10k two-sided)? DEX price vs Chainlink feed deviation <2%? Score 0–100, pass ≥70. Full report written as markdown, stored on GitHub/IPFS, hash pinned on-chain. Known, scored-not-failed risk: B20 mint/redemption is gated by Coinbase and issuance is Reg S — the agent cannot mint, and only trades secondary.
3. **Decide:** target = equal weight across all passing tokens, capped at 25% each. Rebalance if any holding drifts >5% from target, or immediately exit any token that newly fails.
4. **Execute:** one `publishVerdict` batch tx per day; one `rebalance` tx only when triggered (expected 2–3/week); one tiny heartbeat tx per day if nothing else happened, so the activity feed never goes silent. Every tx is posted to the public log with its Basescan link.
5. **Build in public:** daily short X post + GitHub commit with the verdict table and tx hashes (feeds the 25% build-in-public score).

### User-facing interface (single static page, no backend)

- Vault panel: TVL, share price, holdings pie (token → weight → live value), deposit / withdraw buttons (wagmi, Base).
- Audit table: token, score, PASS/FAIL, report link, verdict tx hash.
- Agent activity feed: every on-chain action, newest first, each linked to Basescan.
- "How the agent decides" box: the checklist, the rebalance rule, and the caps — no black box.

## 3. Traction — generated and measured

Traction is the 50% judging criterion, so the product is designed to produce it from day one, from two sources:

| Source | On-chain actions | Expected volume by 5 Dec |
|---|---|---|
| The agent itself | `publishVerdict` batches (1/day), `rebalance` (2–3/week + emergency exits), daily heartbeat | ~60–90 txs |
| Users | `deposit`, `withdraw`, share transfers | Target: 20+ unique depositors; TVL tracked daily |

Measurement: a public dashboard page (same static site) reading event logs via free Base RPC + Basescan free API — total tx count, unique depositors, TVL chart, verdicts published, rebalances executed. No vanity metrics: every number links to its Basescan tx or event. Seeding: the vault starts with the agent's own ~$5 USDC so the first rebalances are real trades before any user deposits; user deposits are capped (per-deposit cap + TVL cap, e.g. $500 total for the demo) so a bug can never trap meaningful funds.

## 4. What is NOT needed

- **No token launch.** Vault shares are plain ERC-4626 receipts for deposited USDC — no sale, no liquidity mining, no listing, no ticker. (This is explicitly allowed: the hackathon requires no token.)
- **No large funds.** Vault seeded with ~$5 of the agent's own USDC; users bring their own small deposits. Gas: Base txs cost ~$0.001–0.003, so ~100 agent txs ≈ $0.10–0.30 — inside the ~0.0023 ETH budget with room to spare. Rebalances are batched and capped at 2–3/week.
- **No paid APIs.** Prices come from on-chain DEX TWAP + free Chainlink feed reads; audit inputs come from free RPC + Basescan free tier. No Chainlink/Pyth subscription, no paid data feed, no Bankr/o1 account, no venue API key.
- **No mint/redeem, no KYC flow in the contracts.** Secondary B20 trading is permissionless; the contracts only swap on DEX.

## 5. Risks / open questions (must resolve in Week 1, before deploying)

1. **B20 + pool addresses are NOT yet verified.** The 13-ticker list (AAPL, AMZN, COIN, CRCL, GOOGL, INTC, META, MSFT, MSTR, NVDA, SNDK, SPCX, TSLA) and the B20 standard (ERC-20, 8 decimals, `multiplier()`) come from public reporting — the build must pin each token address and its Aerodrome/USDC pool address from Base's official list + on-chain checks, and drop any ticker with no liquid USDC pool. Nothing is hardcoded from memory.
2. **Which DEX has the deep pools?** Aerodrome Slipstream is reported as the main B20 venue, Uniswap V3 as secondary. Must confirm per-ticker on a Base fork (Foundry) which router + pool to use; the adapter design exists precisely so a wrong first guess costs a config change, not a redeploy.
3. **Geo / eligibility.** B20 is issued under Reg S (not offered to US persons); secondary transfers are permissionless, but whether the agent wallet may hold/trade B20 needs an explicit check. **Fallback if blocked:** restrict the universe to third-party-issuer stock tokens on Base (no location gate per Bankr docs) or Stonks-paired tokens — same contracts, different token list.
4. **Thin liquidity when US markets are closed.** B20 pools can be thin off-hours; the TWAP + Chainlink deviation check (<2% or skip) and small trade sizes are the mitigation. A rebalance that fails its checks simply does not execute.
5. **Pooled-vault risk.** A vault holding user USDC is custody-adjacent and securities-adjacent. Mitigations: hard TVL/deposit caps, withdraw-anytime, `emergencyExit` + pause, full public audit trail, "experimental demo, not financial advice" labelling. **Fallback if this is judged too risky:** ship the same auditor + strategy in signal-only mode — the agent publishes verdicts and its own tiny trades on-chain, users trade themselves; the vault contract is dropped.
6. **Gas budget is real but small.** ~0.0023 ETH covers hundreds of simple txs at Base gas prices, but a multi-swap rebalance costs more. Batch verdicts, cap rebalance frequency, and monitor the balance; any top-up needs Bre's separate approval.

## Build plan (2–3 weeks)

- **Week 1:** verify B20 + pool addresses; write + fork-test the three contracts; agent audit checklist v1.
- **Week 2:** deploy to Base mainnet (small); agent loop live on cron; static UI + dashboard.
- **Week 3:** traction push (daily verdicts, public posts, invite deposits); submission with Basescan links for every claim.
