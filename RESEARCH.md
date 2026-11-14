# Base "Stocks Maxxing Season" — Research Notes

Researched 2026-11-09 ~18:20 WIB. Read-only; nothing registered or submitted.
Sources: official quest page + official rules (base.org), application form, Crypto Briefing + CryptosBank coverage, Base docs.

## Key facts

| Item | Fact |
|---|---|
| Official page | https://www.base.org/stocksmaxxing |
| Official rules | https://www.base.org/stocksmaxxing/rules |
| Registration / application form | https://docs.google.com/forms/d/1zotYvkeAtDjR2MKk3qNxyNIAfJ_IPQtzTtjNhOAF8js/viewform ("Stocks Maxxing \| Application Form", linked as "Apply Now" on the quest page) |
| Sponsor | Coinbase Technologies, Inc. ("Base") |
| Period | 5 Nov – 5 Dec 2026 (Quest Period, Rules §2) |
| Timeline | Nov 5 applications open; Nov 6–13 brainstorm with partners; Nov 13–Dec 5 build & launch; Dec 5 submit; then winners announced (no fixed announcement date published) |
| Submission deadline | Dec 5, 2026. Rules §2: all times UTC unless the Quest Page says otherwise. BUT the application form itself says "Ends December 5, 2026, 11:59pm EST" — conflicting timezone; treat 11:59pm EST (= 04:59 UTC Dec 6) as the form's stated cutoff and submit well before Dec 5 end of day. No exact hour stated on the quest page itself. |
| Total prize pool | $100,000+ (page header: "1 Month • $100,000+ in Rewards"). Per-track pools exist but amounts are in the Track Sections of the quest page (see Gap below). Partner prizes are ON TOP, under each partner's own terms. |
| Tracks (3, judged separately) | 1. Meme and Community Economies; 2. Agentic Stock Finance; 3. Programmable Stock Markets |
| Judging weights | 50% real onchain traction, 25% product quality, 25% build in public — CONFIRMED by Crypto Briefing + CryptosBank, both sourced from the quest page. Rules §7 says judges score against criteria on the Quest Page, weighted equally unless the page sets different weights (the page sets 50/25/25). |
| Traction definition | "Real onchain usage" — no finer metric (tx count / users / volume) published in the rules or coverage. Rules §13: manipulating engagement or traction metrics = disqualification. |
| Build-in-public prize | $6,000 for the best project developed out in the open (reported by Crypto Briefing + CryptosBank). No separate published rules for it beyond the 25% build-in-public judging weight; see Gap. |
| Prize payment | Amounts in USD, paid in USDC on Base (Rules §10.1), normally within 30 days after verification is complete (§10.2). Winners notified by email / X DM / contact from form; must respond + provide Winner Documents (ID/age/residence proof, sanctions screening, W-9/W-8, wallet address, signed declaration) within 7 days or forfeit (§9). Prizes non-transferable; winners bear taxes; 1099 where required. |
| Partners | o1 Exchange, Bankr, Stonks Exchange, BaseStonk, Feel.cash, Hydropump by Hydrex (listed on quest page; first three named as lead partners in coverage) |
| Eligibility | 18+; not resident in OFAC-sanctioned countries/regions; Base employees/reps/agents + immediate family/household excluded (Rules §4). |
| Team size | Individuals or teams of up to 5; one Team Representative receives the prize and splits it (Rules §4). |
| Identity needed | No GitHub/wallet account required to enter. Entry = (1) public X post with video demo (e.g. Loom) explaining the project, tagging @buildonbase; (2) official submission form (link to X post, track(s), other info). Same identity throughout; submissions via automated means / multiple accounts / other people's identities are void (Rules §5). |
| Submission format | NOT Devpost. X video demo post + Google submission form. No demo-video length, repo, or writeup spec in the rules; form fields not visible in text fetch. |
| What must be built | Built on, or meaningfully integrate with, Base; fit the entered track. New product OR grow a live one. Launching a token is OPTIONAL. No purchase/transaction/wallet funding/token holding/payment required to enter. Testnet builds judged no less favorably than mainnet (Rules §5). |
| Prior work | Allowed: pre-existing code/products the entrant owns/rights to, incl. extending a live product during the Quest Period — but the form must clearly describe what was built during the Quest Period (Rules §6). Quest page: token launched Aug 5–Nov 4, 2026? Eligible only if a NEW stock-linked product/feature ships during the season. Teams that previously launched tokens are "not eligible by default" (page FAQ); a relaunch does not reset the token's original launch date. |
| One submission per track | Each entrant/team max 1 Submission per Track; a single project may enter >1 track only if the page allows it, and may win in only one track unless the page says otherwise (Rules §5). |
| AI agents participating | No rule addresses AI agents as entrants. Entrants are "individuals" 18+; an agent-built project is fine (Agentic Stock Finance track is ABOUT agents interacting with tokenized equities), but the entrant of record must be a human individual/team. No rule bans AI-assisted building. |
| Key restrictions | Must comply with securities/commodities/derivatives/lending/consumer-protection/money-transmission/sanctions law; must NOT claim rights in an underlying public company (e.g. voting rights) the asset doesn't provide; must not misrepresent endorsement by Base/partners/issuers (Rules §6). Form adds: "Any projects that enable trading for U.S. users are not in scope." Tokenized stocks are Reg S / not for U.S. persons (Base docs). |
| IP | Entrants keep ownership; Base/partners get a non-exclusive, royalty-free license for 2 years after the Quest to use public submission materials (X post, demo video, name/logo/descriptions) for administering/promoting — NOT the underlying code/product (Rules §11). |
| Disputes | California law; binding arbitration (AAA), class-action + jury-trial waiver (Rules §15 + App. 1). |
| If <3 eligible submissions in a track | Sponsor may award fewer prizes in that track; unawarded prizes do NOT move to another track unless the page says so (Rules §7). |

## Agentic Stock Finance track

Exact track description per coverage: apps where programs (AI agents), not just people, interact with tokenized equities. No required integration with o1 Exchange / Bankr / Stonks is stated anywhere in the rules or coverage — partners are supporters with their own Partner Tracks/prizes, not mandatory integrations. No starter kit is named for this track. Relevant builder resources on the quest page:

- Builder Codes — attribute onchain activity to your app (docs.base.org)
- Tokenized Stocks API — read token contracts, supply, multipliers, reference values (docs.base.org/sdks/tokenized-stocks/overview — public, read-only, no API key)
- Integrate tokenized stocks — list/integrate tokenized stocks in your app (docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks)
- Builder Stack — credits/discounts on software/services
- "Ideas to build" list on the quest page (content not captured in text fetch)

Background: Coinbase-issued tokenized stocks (B20 tokens, ERC-20-compatible, 8 decimals, 1 token tracks 1 share × onchain multiplier) went live on Base in August 2026, tradable 24/7 on DEXs (e.g. Aerodrome), backed by regulated custodians. Example live agentic entry: "Clanked" ($CLANKED, Clanker, Nov 8 2026) — 1% trade tax in NVDAc split among verified AI agents; self-described as a Stocks Maxxing Season (Agentic Stock Finance) submission.

## Gaps — NOT verifiable by text fetch (needs live browser on base.org/stocksmaxxing)

- Per-track prize breakdown (amounts, # of winners per track) and the $6,000 build-in-public prize's exact rules — these live in the Track Sections of the quest page, which is JS-rendered; the text crawler returned only the page skeleton (timeline, partners, resources, FAQ) without any track-section content. No secondary source publishes the per-track split.
- The Agentic Stock Finance track's exact "Show us" guidance / example ideas — same reason.
- Exact submission-form fields (form text fetch shows only the conditions block, not the questions).
- Winner-announcement date (page says only "Winners announced" after Dec 5).
- Whether a single project may enter multiple tracks (rules defer to the page).

Note: x.com is blocked for the text fetcher, so the @base announcement thread (x.com/base/status/2118282380683206951) could not be read; do not retry via browser_open.

## Source URLs

- https://www.base.org/stocksmaxxing
- https://www.base.org/stocksmaxxing/rules
- https://docs.google.com/forms/d/1zotYvkeAtDjR2MKk3qNxyNIAfJ_IPQtzTtjNhOAF8js/viewform
- https://cryptobriefing.com/base-tokenized-stock-builder-competition/
- https://cryptosbank.in/2026/11/07/base-launches-100000-builder-competition-for-tokenized-stock-products/
- https://docs.base.org/sdks/tokenized-stocks/overview
- https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks
