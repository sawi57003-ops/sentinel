# Sentinel — Verification Log

Every claim below was checked live on 2026-11-09. No address was hardcoded
from memory; each one comes from the source named next to it.

## 1. B20 token universe (official source)

- Source: Coinbase Tokenized Stocks API, `GET https://api.coinbase.com/v1/tokenized-stocks`
  (public, no key; linked from `docs.base.org/sdks/tokenized-stocks/overview`).
- Result: **298 B20 tokens** listed. Full response saved in
  `data/b20-list-raw.json`, compact table in `data/b20-list.json`.
- DESIGN.md's 13-ticker list: **12 of 13 verified** (all with supply + NAV).
  **COINc is NOT in the official list — dropped.**
- All 12 verified tokens are 8 decimals, `multiplier()` ≈ 1 (1e18 WAD).
  On-chain spot check (AAPLc): `symbol()` = "AAPLc", `decimals()` = 8,
  `multiplier()` = 1e18, `totalSupply()` = 6,592,40361951 (matches API).

## 2. Pools (Aerodrome Slipstream, USDC pairs)

- Source: Dexscreener API per token + on-chain `tickSpacing()`/`fee()`/
  `token0()` reads. Saved in `data/pools-dexscreener.json` and
  `data/aero-pools.json`.
- All 12 tokens have a liquid Aerodrome Slipstream USDC pool, all
  `tickSpacing = 10`, `token0 = USDC`. Liquidity at check time:

| Token | Pool | Liquidity | 24h vol |
|---|---|---|---|
| AAPLc | 0xF5FC…BA6 | $525,052 | $4,674,097 |
| NVDAc | 0xF668…8EC | $1,094,080 | $7,936,819 |
| TSLAc | 0x7A33…920 | $432,783 | $6,643,920 |
| MSFTc | 0x2740…1ee7 | $505,548 | $8,824,099 |
| METAc | 0xd072…DC96 | $929,674 | $12,896,624 |
| GOOGLc | 0x16c7…47C3 | $1,701,168 | $9,154,290 |
| AMZNc | 0x532e…DDf6 | $1,772,511 | $10,961,302 |
| CRCLc | 0x2946…1133 | $214,283 | $815 |
| INTCc | 0x3D38…Ad4f3 | **$6,180 (thin)** | $11,855 |
| MSTRc | 0x66DC…c153 | $1,516,485 | $18,933,746 |
| SNDKc | 0x2836…4E75 | $1,661,487 | $28,158,729 |
| SPCXc | 0x880d…B3cFE | $945,341 | $12,980,627 |

- INTCc is thin ($6,180) but exists and trades; the audit score penalises
  it (liquidity component) rather than dropping it.

## 3. B20 is a Base NATIVE token — Foundry cannot execute it

- `eth_getCode` returns a single byte `0xef` for EVERY B20 token and for
  the policy registry `0x8453...0002` (checked on two RPCs). B20 is
  executed by the Base node itself, not as EVM bytecode
  (Chainlink docs: "B20 token, Base's native token standard for
  real-world assets, an extension of ERC-20").
- Consequence: Foundry/revm reverts any B20 call in a fork with
  `OpcodeNotFound`. Fork tests therefore use WETH as a stand-in for the
  swap mechanics, and B20 behaviour is proven against the live node:
  - `cast call --from <AAPLc pool> AAPLc.transfer(burn, 1 AAPLc)` → **`true`**
    (secondary transfer to the burn wallet is permissionless).
  - `cast call --from <burn> AAPLc.transfer(user, 1 AAPLc)` → reverts only
    with `InsufficientBalance(burn, 0, 1e8)` — i.e. the transfer logic ran
    and failed on balance, not on permission.
  - Reg S note: mint/redeem is gated by Coinbase (KYC/authorized
    participants); secondary trading is permissionless. No rule was found
    that bars the agent wallet from holding/trading secondary B20; this
    remains an open legal (not technical) risk — see README.

## 4. Aerodrome router generations — the documented router is WRONG for B20

Three Slipstream factory generations are live on Base. Each SwapRouter is
pinned to ONE factory:

| Router | Factory | WETH/USDC pool it finds | AAPLc pool? |
|---|---|---|---|
| 0xBE6D…18a5 (docs) | 0x5e7B…809A (original) | 0xAaD2… (stale — priced WETH ~$457k) | **none** |
| 0xcbBb…Ce0D | 0xaDe6…16a (GaugeCaps) | 0xc758… (~$2,117 ✓) | **none** |
| (none identified) | **0x9CB2…07a76** | 0x4A7a… ($9.2M, correct price) | **0xF5FC… (deep)** |

- Proven live: a `buy` through router 0xcbBb… reverted with
  "call to non-contract address" (it resolved a CREATE2 pool address that
  doesn't exist, because its factory has no AAPLc pool).
- Proven on fork: router 0xBE6D… executed a $1 USDC→WETH swap at
  $8,865/WETH (4.2× off market) against its stale pool.
- Resolution: **SentinelStrategy swaps DIRECTLY against each token's
  verified pool** (`pool.swap()` + `uniswapV3SwapCallback`), no router.
  Fork-tested against the real WETH/USDC pool (same factory as the B20
  pools) and proven live with the $0.75 AAPLc buy (see §6).

## 5. The pool-hook gas trap ('IG')

- The 0x9CB2… pools use Aerodrome's `DynamicSwapFeeHook`
  (0xC0ed…e434, Sourcify-verified). Its `afterSwap` does:
  `require(gasleft() > recordCallGasLimit, 'IG')` where
  `recordCallGasLimit = 250,000`.
- ethers' gas estimation simulates with a huge gas limit, so the estimate
  (~684k) passes estimation but leaves ≤250k gas at the hook checkpoint
  in the real tx → revert 'IG'. This killed 13 live buy attempts
  (NVDAc/TSLA/MSFT/META/GOOGL/AMZN ×2 + probe) while identical
  `eth_call` simulations succeeded.
- Fix: strategy swaps are sent with an **explicit gas limit of 1,500,000**
  (only gas actually used is paid, ~480–620k). All 11 remaining buys
  then succeeded on first attempt.

## 6. Mainnet deployment + live trades (Base, burn wallet)

- Deployer: burn wallet `0x41102aD3c29FF70E457B25CeAc0F120a1ed7B337`.
- Contracts (`data/deployment-mainnet.json`):
  - SentinelOracle `0x4825599E54C18a64F3Ea3241f447A3801c0cfB76`
  - SentinelAuditor `0x46E341A0a0e934d12aAf886125F03b6914D75388`
  - SentinelVault `0x7469E23D2Fc7CDFe0cfAAA0746Da225411ba63c9`
  - SentinelStrategy v2 (direct-pool) `0x14EEa452237427Cf5E3072bBB2A8526c8406d909`
    (v1 router-based `0x21812e17B03df35131cF432c6332fC26BFD808a5` superseded)
- Seed: 0.0015 ETH → $3.184284 USDC → deposited (tx
  `0xc94d8ef3f529b7c778908f42969622b6c48b5c32e66b20b31a9c05baeedc64f0`).
- First live B20 trade: **$0.75 AAPLc buy**, tx
  `0x63e09430125c5d7d534dbe92acc97e9029505c1913565d55ec50b384ca98aa8d`
  (vault received 217,636 AAPLc units = 0.00217636 AAPLc @ $344.50).
- Agent loop live run 2026-11-09: verdict batch (12 tokens)
  `0x2b423cafd0b9a67fda1d51d58e2adfb1bca6b5c66cccf3e77ce589406b3b0132`,
  oracle prices `0x7e36b4a32129499cd872153446ae6980146efab9082488997232b28226d66931`,
  AAPLc sell `0xbe9033030246faa42c25dc090bf3a1c3c9c43469f9df5beaa5406e9e7a672328`,
  buys NVDAc `0xc37c87254295bda553a689a3fda850f72858215cfe3281e469c86a899a381928`,
  TSLAc `0x645a2ece4b676c6107a71d0e23118432f8765779f2e77f553e852546d8fb227d`,
  MSFTc `0x68b322328fc72633ea4c552ef69b8281756bbd4774e2d6216bb8818c328c1709`,
  METAc `0x221022da04a885cb7dc1d9741ca4041f0bc8a6e152cadd779f39d76d8a06a5ed`,
  GOOGLc `0xbb2d9feba8bbf93f77b41b2599ba5462e131ea2ffffd927f345d6b7c0395c928`,
  AMZNc `0x5d632faf90c0eb766b920c9cbe242264f9b6fa820297d255c8e43214afc6ce5a`,
  SNDKc `0x97163358740a596636236af745d943e4abe077810388d3726ba50d1786db4036`
  (+ CRCLc, INTCc, MSTRc, SPCXc buys in the same run).
- Resulting vault state (verified on-chain 2026-11-09 ~19:55 WIB):
  all 12 B20 tokens held ≈ $0.26 each, totalAssets $3.168, USDC $0.0017.
- Gas spent total: **0.000176 ETH (~$0.37 @ $2,117/ETH)** including all
  failed attempts. Burn wallet balance left: ~0.000625 ETH (~$1.32).

## 7. Tests

- `forge test`: **24 passed, 0 failed** (20 unit with mock pools +
  4 fork against Base mainnet: real WETH/USDC pool buy, round-trip,
  emergency exit, callback access control).
- Base Sepolia deployment: **BLOCKED** — burn wallet and agent wallet
  both hold 0 Base Sepolia ETH and public faucets require accounts.
  The Base-mainnet fork tests are the substitute E2E evidence; no
  Sepolia deployment was attempted rather than moving main holdings.
- Basescan source verification: **NOT done** — no Basescan API key is
  available in this environment. Contracts are Sourcify-verifiable from
  `contracts/` (standard JSON via `forge verify-contract` once a key
  exists, or manual Basescan UI verification).

## 8. Known limitations / open risks

1. B20 secondary trading by the agent wallet is technically proven
   (transfer simulation + live AAPLc buy/sell) but no explicit legal
   clearance was found; Reg S restricts OFFERS to U.S. persons — the
   product does not target U.S. users.
2. The vault's `totalAssets()` values B20 via the agent-updated oracle
   (official API NAV), not an on-chain TWAP — the DESIGN's in-vault TWAP
   was replaced by the simpler oracle + a 2% pool-vs-NAV check in the
   audit score. A stale oracle (>48h) values holdings at 0 until updated.
3. Withdrawals settle only from the vault's USDC balance; if the vault
   is fully invested, a withdrawal reverts until the agent sells.
4. The DynamicSwapFeeHook's `recordCallGasLimit` (250k) means every
   strategy swap must be sent with a generous explicit gas limit; a
   future hook-parameter change could break this again.
5. INTCc liquidity is thin ($6,180); $0.27 trades are fine, larger
   trades would move its price.
6. ETH price at build time: ~$2,117 — the wallet's 0.0023 ETH was
   ~$4.87, so the seed is ~$3.18, not the $5 in DESIGN.md.
