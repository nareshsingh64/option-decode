# Margin calculation — reference

**Status: reference only. Nothing here is implemented, and nothing should be
until these numbers are approved.**

The app currently asks Dhan for every live margin figure and does not compute
one. This document exists so that a decision about whether to compute any of it
ourselves can be made from evidence rather than from intuition, and so the
numbers we already measured are not lost.

Two kinds of statement appear below and they are deliberately separated:

- **Measured** — observed against the real Dhan account on 2026-08-30/31 via
  read-only calculator calls. Reproducible; the figures are exact.
- **Published** — from exchange and broker documentation. Accurate as
  descriptions of policy, but rates change and several are set daily.

Where the two disagree, that is recorded rather than resolved. An unexplained
disagreement is more useful than a confident average.

---

## 1. What this app does today

| Path | Source of the number |
|---|---|
| Live Order preview | `POST /v2/margincalculator/multi`, `includePosition: true`, `includeOrder: true` (basis still under review — §5) |
| Live per-leg hedge benefit | `POST /v2/margincalculator/multi`, one leg at a time, standalone |
| Paper Trade Pro / backtests | `shortLegMarginPerUnit()` in `@option-decode/types` — a local model |
| Funds available | `GET /v2/fundlimit` |

The local model is **only** used by the simulator and the backtests. It is
described in §6 because it is the thing any implementation would replace, and
because it is already known to be wrong on MCX.

---

## 2. The exchange framework

Indian derivatives margin is not one number. The upfront requirement is:

```
Total upfront margin  =  SPAN (initial)  +  Exposure (ELM)
```

with several additional margins that apply only in specific situations.

### SPAN / initial margin

Portfolio-based, computed by the clearing corporation, not by a formula anyone
can reproduce from a price. It values the whole portfolio under **16 risk
scenarios** — combinations of underlying price moves and volatility shifts — and
takes the worst case, targeting **99% one-day value at risk**.

Two consequences that matter more than the mechanism:

- **It is portfolio-level, not position-level.** A short call and a long call in
  the same underlying are scanned together, which is why a spread costs a
  fraction of a naked short and why margin cannot be computed leg by leg and
  summed.
- **It changes during the day.** NSE Clearing publishes risk parameter files
  several times a session, so the same position can require different margin in
  the afternoon than it did at entry, with no trade and no market move against
  you.

### Exposure margin / Extreme Loss Margin (ELM)

A flat percentage-of-notional buffer on top of SPAN, for losses beyond what the
scenario model covers. Published base rates:

| Instrument | ELM |
|---|---|
| Index futures | 2% of contract value |
| Stock futures | 3.5% of contract value |
| Index options (short) | ~3% of notional |
| Stock futures / short options | higher of 5% or 1.5 standard deviations |

Charged on **short** option positions only. A bought option has no exposure
margin because its loss is bounded by the premium already paid.

### Margins that apply only sometimes

| Margin | When | Basis |
|---|---|---|
| Premium margin | Option buyer | 100% of premium, upfront, since 2025-02-01 |
| Assignment margin | Short option assigned at expiry | Net settlement obligation |
| Delivery margin | ITM **stock** options into expiry | Ramps: E-4 10%, E-3 25%, E-2 45%, E-1 70%, E 100% of applicable risk margin |
| Calendar spread | Long one expiry, short another | Benefit up to 50%, **removed from 16:00 the day before the near leg expires** |

The delivery ramp is the one that surprises people: a stock-option short that
was comfortable on Monday can require several times the margin by Thursday
purely from the calendar, and `docs/live-order-module.md` §2.6(d) notes MCX has
an analogous devolvement problem.

### Peak margin

Clearing corporations take **four random snapshots** per session. The highest
observed requirement is what counts, so a position that only briefly exceeded
available margin still creates a shortfall. This is the reason the Live Order
module keeps a utilisation ceiling below 100% rather than sizing to the full
balance.

Also relevant from 2026-04-01: at least **50% of F&O collateral must be cash or
cash equivalent**.

---

## 3. Per-instrument summary

| Instrument | Long | Short |
|---|---|---|
| Index option | Premium only | SPAN + ELM (~3% notional) |
| Stock option | Premium only | SPAN + ELM, plus the delivery ramp into expiry if ITM |
| Index future | SPAN + 2% | SPAN + 2% |
| Stock future | SPAN + 3.5% | SPAN + 3.5% |
| Commodity (MCX) | Premium only (options) | SPAN + ELM, typically **6–10%+** of contract value, higher for volatile contracts |

Published MCX guidance puts initial margin around 6% for lower-volatility
contracts and above 10% for silver, crude oil and natural gas. **Our own
measurement disagrees with the low end sharply — see §5.**

---

## 4. Dhan's API contract

```
POST /v2/margincalculator          single leg
POST /v2/margincalculator/multi    basket
```

Multi request body — note the field names, which cost this repo real time:

```jsonc
{
  "dhanClientId": "…",
  "includePosition": true,   // singular
  "includeOrder":    true,   // SINGULAR - not includeOrders
  "scripList": [             // NOT "scripts"
    { "exchangeSegment": "NSE_FNO", "transactionType": "SELL", "quantity": 65,
      "productType": "MARGIN", "securityId": "…", "price": 128.5, "triggerPrice": 0 }
  ]
}
```

Dhan's own documentation contradicts itself on both names — the curl example and
the structured spec on the same page disagree. The official Python client
(`dhan-oss/DhanHQ-py`, `_funds.py`) settles it, and this repo sent the wrong
names for the whole life of the feature: 195 `PaperOrder` and 180
`PaperPosition` rows carry a NULL `marginRequired` as a result.

Documented response fields: `totalMargin`, `spanMargin`, `exposureMargin`,
`variableMargin`, `availableBalance`, `insufficientBalance`, `brokerage`,
`leverage`; the multi variant adds `equity_margin`, `fo_margin`,
`commodity_margin`, `hedge_benefit`.

Dhan states margins are **indicative and valid only for the current session**.

---

## 5. Measured against the real account

All read-only calculator calls, 2026-08-30, account balance ₹1,27,539.85.

### Index options (BANKNIFTY, lot 30)

| Position | Quantity sent | Total margin | Leverage |
|---|---|---|---|
| SELL 58000 CE @ 150, `MARGIN` | 30 | **₹1,78,392** | 9.78× |
| SELL 58000 CE @ 150, `INTRADAY` | 30 | **₹1,78,392** | 9.78× |
| SELL 56500 CE @ 300, `MARGIN` | 30 | **₹2,22,712** | 7.65× |
| BUY 58000 CE @ 150 | 30 | **₹4,500** | 1× |

**`MARGIN` and `INTRADAY` returned an identical figure.** That contradicts
broker material describing 1.3× intraday leverage on F&O. The most likely
reconciliation is that intraday leverage applies to futures rather than to short
options under peak-margin rules — **unverified, and worth testing on a future
before relying on it either way.**

The long leg cost exactly its premium (150 × 30 = ₹4,500) at 1× leverage,
confirming bought options attract premium only.

### Commodity (CRUDEOIL, lot 100, spot 7,797)

| Position | Quantity sent | Total margin |
|---|---|---|
| SELL 6500 PE @ 40 | **1** | ₹2,49,675 |
| SELL 6500 PE @ 40 | **2** | ₹4,99,350 |
| SELL 6500 PE @ 40 | **100** | ₹2,49,67,500 |
| SELL 6000 CE @ 60 | 100 | ₹4,44,86,500 |

**`quantity` means LOTS on `MCX_COMM` and CONTRACTS on `NSE_FNO`.** Perfectly
linear across 1 / 2 / 100. This is the single most dangerous asymmetry here:
`lots × lotSize` — correct everywhere else in this repo — sends an MCX order
**100× too large**, and it fills rather than erroring. Guarded by
`toBrokerQuantity()` in `@option-decode/types`.

**Implied commodity rate.** One CRUDEOIL lot is 100 units, so notional at 7,797
is ₹7,79,700:

| | model at 20% | measured | implied rate |
|---|---|---|---|
| 6500 PE, OTM | ₹1,55,940 | ₹2,49,675 | **32.0%** |
| 6000 CE, ITM by 1,797 | ₹3,35,640 | ₹4,44,865 | ~34% |

Solving the OTM case gives **basePct ≈ 0.32**, which reproduces it to within
**0.07%** (0.32 × 7,797 × 100 = ₹2,49,504 against ₹2,49,675). That is far above
the 6–10% published guidance, and the gap is unexplained. Possibilities worth
testing: the published figures describe futures rather than short options; the
contract was near expiry; or a volatility-driven margin uplift was in force.
**Two strikes on one commodity on one day is not enough to generalise.**

### What the API does and does not give us

Re-measured 2026-09-01 against a **real hedged basket already in the account** —
short NIFTY 08-Sep 24300 CE (secId 42651) and long 24750 CE (secId 42671), one
lot each. All read-only.

**The `multi` endpoint works.** The all-zeros response recorded earlier was the
`scripts`/`includeOrders` field-name bug and nothing else. With the corrected
names it returns a full breakdown.

| Basket | totalMargin | span | exposure |
|---|---|---|---|
| Short leg alone, standalone | ₹1,60,386.72 | 1,28,859.90 | 31,526.82 |
| Long leg alone, standalone | ₹672.75 | 0 | 0 |
| **Both legs together, standalone** | **₹59,414.42** | 27,214.85 | 31,526.82 |
| Both legs, order reversed | ₹59,414.42 | identical | identical |

**Hedge benefit is real and large.** Priced separately the two legs cost
₹1,61,059.47; priced together, ₹59,414.42. That is a **₹1,01,645 reduction,
63%**. Leg order does not matter.

**The published formula reproduces exactly**, which is a useful confirmation
that the framework in §2 is the right mental model:

```
naked short:  1,28,859.90 (SPAN) + 31,526.82 (exposure)                = 1,60,386.72  ✓
the spread:      27,214.85 (SPAN) + 31,526.82 (exposure) + 672.75 (premium on
                                                    the long leg) =    59,414.42  ✓
```

So `Total = SPAN + Exposure + premium paid on long legs`, to the paisa.

**`spanMargin` and `exposure` ARE populated on `multi` — only the SINGLE
endpoint returns zeros.** An earlier note in this document said they were zero
everywhere; that was measured on `/v2/margincalculator` and does not hold for
`/v2/margincalculator/multi`.

**The response field names are not the ones our client parses.** Actual keys:

```jsonc
{ "clientId":"…", "totalMargin":59414.42, "spanMargin":27214.85,
  "exposure":31526.82,        // NOT exposure_margin / exposureMargin
  "equityMargin":0.0, "foMargin":59414.42,
  "commodity":0.0,            // NOT commodity_margin / commodityMargin
  "currency":0.0,             // a NUMBER, not the "INR" string we expect
  "hedgeBenefit":0.0,         // a NUMBER, and always zero - see below
  "userFundLimit":0.0, "insufficientFund":0.0 }
```

`calculateMultiOrderMargin` reads `exposure_margin ?? exposureMargin` and
`commodity_margin ?? commodityMargin`, neither of which exists, so
**`requirement.exposure` and `requirement.commodity` are permanently null in the
UI** — a real breakdown is being discarded. `hedgeBenefit` is typed as a string
and arrives as a number, so it always resolves to undefined.

**`hedgeBenefit` is useless regardless.** It returned `0.0` on the basket whose
benefit was demonstrably ₹1,01,645. The benefit has to be derived by differencing
standalone legs against the combined basket, which is what the app already does.

**`includePosition: true` returns the TOTAL portfolio requirement, not the
incremental cost of the new basket.** This is the important semantic and it is
the opposite of what the Live Order module assumes. Proof, unambiguous because a
long option cannot possibly require ₹42,297 on its own:

| Basket | includePosition | totalMargin |
|---|---|---|
| Long 24750 CE alone | false | ₹672.75 |
| Long 24750 CE alone | **true** | **₹42,297.32** |

The difference, ~₹41,625, is the requirement of what the account already holds.
Confirmed again on a new short at an unheld strike (24600 CE): ₹1,41,950.77
standalone against ₹2,01,312.54 with `includePosition` on, and exposure scaling
in exact 1×/2×/3× multiples of a 31,526.82 unit as short legs accumulate.

**`includeOrder` is untested.** The order book held zero pending orders, so
`true` and `false` returned identical figures. It is not verified working — only
verified not to break anything.

### The `includePosition` asymmetry — two symptoms, one cause

`computeLiveMarginView` (live-repository.ts ~740) prices the **basket** with
`includePosition: true` while pricing each **leg** standalone, then compares the
two. That asymmetry produces two separate visible defects, and neither is fixed.

The mechanism: `includePosition: true` returns the whole portfolio's
requirement (§5), so `netMargin` carries the existing book while `grossMargin`
— the sum of standalone legs — does not. The two are not comparable, and every
consumer of the comparison inherits the error.

**Symptom 1 — the shortfall is overstated.**

```ts
const netMargin = basket.totalMargin;            // TOTAL portfolio requirement
const free = funds.availableBalance - netMargin;
insufficientBalance: Math.max(0, netMargin - funds.availableBalance)
```

`availableBalance` is already **net of** what existing positions have blocked —
`fundlimit` on 2026-09-01 read SOD ₹1,27,587.02, utilised ₹58,836.00, available
₹70,430.66. The existing book is therefore subtracted **twice**: once inside
`availableBalance`, and again because `netMargin` contains it.

The clean proof is the standalone long wing, because a bought option cannot
require ₹42k on its own:

| Quote | `includePosition` | totalMargin |
|---|---|---|
| Long 24750 CE alone | false | ₹672.75 |
| Long 24750 CE alone | **true** | **₹42,297.32** |

The ~₹41,625 difference is the existing book being folded in. (Any "overstated
by exactly ₹41,625" arithmetic elsewhere is circular — that figure is *derived*
from this pair, not independently measured. The pair above is the evidence; the
subtraction is not.)

This is the reported symptom *"naked CE sell says insufficient funds ... but we
already have the hedging leg in the account"*. Note the reported ₹1,60,387
matches the **standalone naked short** (₹1,60,386.72) to the rupee, so that
quote had no position credit at all — turning `includePosition` on moved the
number the wrong way rather than fixing it.

**Symptom 2 — the hedge benefit always reads ₹0.**

Found 2026-09-01 running the real `computeLiveMarginView` locally against live
Dhan (NIFTY 08-Sep, one lot):

| Ticket | total | span | exposure | gross | **benefit** | util |
|---|---|---|---|---|---|---|
| Naked short 24650 CE | ₹1,98,477.24 | 1,34,750.85 | 63,053.64 | ₹1,39,130.42 | **₹0 (0.0%)** | 281.8% |
| Spread 24650/24850 | ₹1,62,872.06 | 66,208.35 | 94,580.46 | ₹1,39,868.17 | **₹0 (0.0%)** | 231.3% |

**The hedge genuinely works — the spread costs ₹35,605.18 less than the naked
short — and the panel reports a benefit of zero.** Because `net` carries the
existing book and `gross` does not, `net > gross` always, so

```ts
benefitAmount = Math.max(0, grossMargin - netMargin)   // clamps to 0, every time
```

The comment at live-repository.ts:737 argues the per-leg calls stay standalone
"on purpose ... including positions in both halves would net the same relief out
of the comparison". That reasoning is inverted: the asymmetry does not preserve
the benefit, it destroys it. Both halves must share one basis — whichever basis
is chosen.

Both symptoms also drove `wouldBreach = true` on both tickets above, so nothing
could be placed at all.

**Two shapes would be correct. This is a decision, not a mechanical fix:**

- **Incremental**: quote the basket with `includePosition: true` and subtract a
  baseline quote of the existing book, then compare the difference against
  `availableBalance`. Costs one extra call per preview, and makes `gross` and
  `net` comparable again because both then exclude the existing book.
- **Absolute**: keep `includePosition: true`, compare against `sodLimit` (total
  capital) rather than `availableBalance`, and price the per-leg `gross` with
  `includePosition: true` as well so the benefit comparison shares a basis. One
  call, but it leans on `sodLimit` genuinely representing the whole book's
  capital.

Neither is implemented. Both need approval.

**The local environment can now verify either one.** As of 2026-09-01 local dev
runs this path end to end: both live-module migrations applied, an encrypted
`UserBrokerCredential` seeded for the real account, and a `LiveAccount` with
`tradingEnabled = false`. The margin calculator and `fundlimit` are read-only,
so a validation run places no orders. The only recurring chore is the access
token — a successful `RenewToken` on production kills the copied token
*immediately*, not at its nominal expiry, so `.env.local` needs re-copying after
each renewal (see the token schedule in CLAUDE.md).

## 6. The local model, and where it is wrong

`shortLegMarginPerUnit()` in `packages/types/src/index.ts`:

```
margin per unit = basePct × spot + max(0, amount the short is ITM)
multiply by lotSize × lots
```

| Class | basePct | Provenance |
|---|---|---|
| Index | 0.085 | Middle of a published ₹1.25–1.5 lakh per NIFTY lot range; verified in production at ₹1,34,622 |
| Single stock | 0.20 | SEBI-style prescribed minimum |
| **Commodity** | **falls through to 0.20** | **Nobody chose this** |

The commodity case is the defect. `INDEX_MARGIN_UNDERLYINGS` lists only the
seven indices, so CRUDEOIL, NATURALGAS, COPPER and SILVER take the single-stock
figure by accident, and §5 shows that **understates** by roughly 1.6×. An
understating error flatters the account and is the harder kind to notice — the
same shape as the rupees-versus-points bug this repo has already had once.

The BANKNIFTY measurement also sits above the index figure: ₹1,78,392 over 30
units implies ~10.6% of spot against the model's 8.5%. BANKNIFTY is more
volatile than NIFTY so a higher rate is expected, but **the model has one index
rate for all indices** and that is worth revisiting.

Structural limits of the model, which no coefficient fixes:

- It sums legs independently, so it **cannot express a hedge**. A bear call
  spread prices as two naked shorts.
- It has no volatility term, so it cannot move when SPAN does.
- It cannot know about existing positions.

---

## 7. What would need deciding before implementing anything

1. **Should we compute margin at all, or only ever ask Dhan?** The broker's
   number is authoritative, accounts for the portfolio, and is already used
   everywhere it matters. A local model earns its place only where Dhan cannot
   be called: backtests over historical data, and offline sizing.
2. **If we do compute it — is a percentage-of-notional model good enough for
   backtests?** It cannot express hedges, which makes it structurally wrong for
   any spread strategy. `docs/index-option-selling-backtest.md` already depends
   on it.
3. **Commodity rate.** 0.32 fits two CRUDEOIL strikes on one day to 0.07%. It
   needs re-measuring on NATURALGAS, COPPER and SILVER, and on a different day,
   before it becomes a constant.
4. **Per-index rates.** One 8.5% for NIFTY, BANKNIFTY, FINNIFTY, SENSEX and the
   rest is probably too coarse given the BANKNIFTY reading.
5. ~~Does the `multi` endpoint work now?~~ **Answered 2026-09-01: yes**, and it
   raised two defects of its own. The `exposure`/`commodity`/`currency` parse
   mismatch is **fixed** (`packages/dhan/src/index.ts`, regression-tested
   against a captured payload). The **`includePosition` asymmetry is still
   open** and is the only decision blocking the live margin path — it has two
   symptoms, an overstated shortfall and a hedge benefit that always reads ₹0.
   See §5.
6. **Is `MARGIN` really identical to `INTRADAY` for futures too?** Measured only
   on a short option.

---

## 8. Suggested order of work, if approved

1. ~~Verify `multi` end to end.~~ ~~Fix the `exposure`/`commodity` field
   names.~~ **Both done 2026-09-01 — see §5.**
2. **Decide the `includePosition` basis** (incremental vs absolute, §5). This is
   the top priority and is not a research task: the live margin path currently
   reports a ₹0 hedge benefit on real spreads and refuses fundable trades, and
   local dev can verify either shape immediately.
3. Measure a naked short on all four MCX commodities and on three indices, on
   two different days. That produces real coefficients instead of one fitted
   point.
4. Only then decide whether to change `shortLegMarginPerUnit`, and if so, add
   `MARGIN_BASE_PCT_COMMODITY` as a **measured** constant with its provenance in
   the comment — the way the 8.5% index figure carries its ₹1.25–1.5 lakh range.
5. Leave the live path asking Dhan regardless. Nothing measured here suggests a
   local model could safely size a real order.

---

## Sources

Exchange and regulator:
- [NSE Clearing — Margins](https://www.nseclearing.in/risk-management/equity-derivatives/margins)
- [NSE Clearing — NSCCL SPAN](https://www.nseclearing.in/risk-management/equity-derivatives/nsccl-span)
- [NSE Clearing — Risk management FAQ (PDF)](https://www.nseclearing.in/sites/default/files/2026-01/NCL%20-%20FAQ_RISK_MANAGEMENT.pdf)
- [MCX Clearing — Daily margin](https://www.mcxccl.com/risk-management/daily-margin)

Broker and secondary (policy descriptions, rates change):
- [Dhan — Funds & Margin API](https://dhanhq.co/docs/v2/funds/)
- [Dhan — Risk management policy](https://dhan.co/risk-management-policy/)
- [Zerodha — Types of margin](https://support.zerodha.com/category/trading-and-markets/margins/margin-leverage-and-product-and-order-types/articles/different-types-of-margin)
- [Zerodha — Physical settlement policy](https://support.zerodha.com/category/trading-and-markets/trading-faqs/f-otrading/articles/policy-on-physical-settlement)
- [Groww — Physical delivery margin](https://groww.in/help/stocks,-f&o,-ipo-&-mtf/sx-fno/how-do-i-calculate-physical-delivery-margin--51)
- [SEBI peak margin rules explained](https://www.bajajbroking.in/blog/sebi-peak-margin-rules)

Measured figures in §5 are from this repository's own read-only probes and are
not sourced externally.
