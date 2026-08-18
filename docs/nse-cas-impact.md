# NSE Closing Auction Session (CAS) — what changed, measured against our own data

Effective **2026-08-03**, NSE and BSE replaced the last-30-minutes-VWAP closing
price for F&O-eligible cash stocks with a 20-minute **Closing Auction Session**
(SEBI circular `HO/47/11/11(3)2025-MRD-POD2/I/2765/2026`, 16 Jan 2026). The
index closing values are built from those constituent closes, so **index option
final settlement is now a single auction print rather than a 30-minute
average**. That is the whole story for option selling; everything below is the
detail and the numbers.

Every figure in the "Measured" sections comes from this app's own capture
(`OptionChainSnapshot`, `OptionContractTick`, `WavePricePoint`) cross-checked
against the NSE bhavcopy closes in `DailyBar`. Nothing here is quoted from a
broker blog.

## The mechanism

| Phase | IST | What happens |
|---|---|---|
| Continuous trading ends | 15:15 | F&O-eligible cash stocks stop trading. Non-F&O stocks carry on to 15:30 on the old method. |
| Transition | 15:15–15:20 | Reference price = **VWAP of 15:00–15:15**. Live orders carried in; stop-loss, iceberg, IOC and GTT orders are **cancelled**. |
| Order entry I | 15:20–15:25 | Limit + market orders. Exchange publishes indicative equilibrium price, imbalance, and an indicative index value. |
| Order entry II | 15:25–15:30 | **Limit orders only.** Entry freezes at a **random moment between 15:28 and 15:30**. |
| Matching | 15:30–15:35 | Single equilibrium price; every trade fills there. This becomes the official close. |
| F&O continuous | until **15:40** | Derivatives keep trading through and past the auction. |
| Cash post-close | 15:50–16:00 | At the closing price. |

- **Price band is ±3% of the reference price.** Orders outside it are rejected,
  which puts a hard cap on how far one stock's close can travel from its
  15:00–15:15 VWAP.
- **Equilibrium rule:** maximum executable volume; tie broken by smallest
  buy/sell imbalance, then by proximity to the reference price. If nothing
  matches, the reference price becomes the close and no trades happen.
- **Not verified, check the NSE circular before relying on it:** sources
  disagree on whether a ±3% band also applies to *futures* orders between 15:15
  and 15:40. Zerodha says futures orders outside the band are cancelled at
  15:15 but that no band applies during the window; another source says the
  band governs futures throughout. Options are agreed to be exempt.

## Measured: the terminal gap widened 3–7x

For every F&O stock we track, the gap between the last traded price at 15:15
and the official bhavcopy close. Pre-CAS that gap is "last 15 minutes of
trading plus VWAP smoothing"; post-CAS it is the auction step. Either way it is
the same question — **how much can the settlement price move after you stop
being able to trade the underlying continuously?**

| | pre-CAS (28–31 Jul) | CAS (3–7 Aug) |
|---|---|---|
| stock-days | 836 | 1,045 |
| mean absolute gap | **9.0 bps** | **39.0 bps** |
| by session | 10.0 / 8.0 / 9.2 / 8.6 | 62.6 / 47.6 / 33.5 / 26.2 / **25.1** |
| worst single stock | 235 bps | **323 bps** (at the ±3% band) |
| % closing above the 15:15 price | 40.9% | 61.0% (79.9% → 51.7%) |

Two things matter more than the averages:

- **It is converging, not exploding.** 62.6 bps on day one down to 25.1 bps by
  day five. But 25 bps is still ~2.8x the pre-CAS 9 bps, and five sessions is
  not enough to say where it settles. Re-run this table monthly.
- **The day-1/day-2 upward bias was a transition artifact.** 79.9% of stocks
  closed above their 15:15 price on 3 Aug (mean +45.8 bps); by 7 Aug it was
  51.7% and +7.9 bps. Do **not** build a "the auction closes higher" strategy
  on the headline number — it decayed to a coin flip within a week.

At index level (NIFTY, close minus the 15:15 price):

```
pre-CAS  28-31 Jul   +18.15  -3.00  -0.75  -8.80          mean abs   7.7 pts
CAS       3-14 Aug  +195.60 +155.10 +64.20  +6.00 +16.80
                     +27.70  +23.15 +67.70 +39.70  -5.75  mean abs  60.2 pts
last 5 sessions                                            mean abs  32.8 pts
```

The largest auction step so far is **195.6 NIFTY points, 0.80%**, on day one.
Our captured last-print matched the official `DailyBar` close **exactly** on all
five days where both exist, so this is the settlement value, not an approximation.

## Measured: what the option market does in the frozen window

SENSEX weekly expiry, **Thursday 13 Aug 2026**, 77900 strike. Spot froze at
**77,861.48** at 15:15 — 38 points below the strike, so the call was OTM with
25 minutes of trading left. Put-call parity on the expiring contract
(`strike + CE − PE`) gives the option market's implied auction close:

```
15:15-15:24   77,857 - 77,864   flat, tracking the frozen spot — no information
15:25         77,922.6          +61
15:26         77,986.4          +125
15:28         78,000.0
15:29         78,042.0
15:30         78,079.5          locks
15:31-15:41   78,079.7          constant to the F&O close
```

The auction closed **+218 points (+0.28%)** above the frozen spot. The 77900 CE
went **10.15 → 179.70 in six minutes** while the published spot never moved, and
then sat at exact intrinsic (179.75, with the PE at 0.05) for the final eleven
minutes.

Three consequences follow directly:

1. **A short call that was 38 points OTM at 15:15 settled 180 points ITM**, and
   the underlying was untradeable for the whole move. This is the CAS risk in
   one trade — and it is *unhedgeable in the cash market* by construction.
2. **The settlement-relevant price is discoverable ~10 minutes before the
   options stop trading.** The random close is 15:28–15:30; after it the
   equilibrium is fixed but not published until ~15:35, while F&O trades to
   15:40. Someone is reading the auction book — our own spot feed is frozen
   through that entire move, so **the option market is repricing off
   information the app cannot currently see**.
3. **After ~15:30 on expiry day, time value is zero and our model does not know
   it.** The payoff is already determined; `getYearsToExpiry` still runs to
   15:41 IST (`NSE_CLOSE_UTC_HOUR/MINUTE`).

## What this means for option selling

Stated as hypotheses to test, not conclusions. The repo's own standard applies:
ten sessions is a short sample, and the last time a metric was read over a short
window here it reversed on fuller data.

- **Settlement risk is now a point estimate, not an average.** The old 30-minute
  VWAP was a smoothing mechanism: to move settlement you had to move the index
  for half an hour. Now a single auction print decides it. Every expiry-day
  short-gamma position carries a new terminal jump of, so far, 0–196 NIFTY
  points with a mean absolute of ~33 points over the last five sessions.
- **It does not by itself breach a wide strangle.** A 0.15-delta weekly NIFTY
  strike sits ~300–360 points out; the largest observed step is 196. But it eats
  a large fraction of the buffer, and for **expiry-day straddles, iron flies and
  anything near ATM the step is the same order of magnitude as the credit**.
- **Buffer, not just delta.** Strike selection that targets a delta band alone
  is now under-specified for a position held into settlement. The natural
  addition is a floor of *k × (recent auction-step distribution)* on top of the
  expected-move window. We do not yet have enough sessions to fit k.
- **The ±3% band is a genuine, hard bound per stock.** For stock options,
  settlement cannot travel more than 3% from the 15:00–15:15 VWAP. For the index
  the bound is the weighted sum, which in practice has been ~4x tighter than
  the theoretical worst case.
- **The 15:30–15:40 window is a different regime.** For the expiring contract it
  is a settled payoff still quoted; for the next expiry it is a live market with
  a known spot. Anything that treats 15:15–15:40 as ordinary session time —
  IV surfaces, pressure scores, DRCR — is mixing two regimes.

## Build list

Ordered by how much each is worth relative to its cost.

1. **Synthetic auction-close indicator.** During 15:15–15:35, publish
   `strike + CE − PE` on the nearest-ATM expiring contract as the implied
   settlement level, alongside the frozen spot. We already capture everything it
   needs; the SENSEX trace above is the whole algorithm. This is the single
   highest-value item — it turns an invisible move into a displayed number.
   Verify it against `DailyBar` closes the same way this document did.
2. **Fix `apps/api/src/server.ts:2219`.** It carries a private duplicate of
   `isMarketSessionOpen(9, 15, 15, 30)` that the move to `NSE_SESSION_*` in
   `@option-decode/types` missed. Between 15:30 and 15:41 IST the API therefore
   serves the **stored** ticker feed instead of the live one — precisely across
   the CAS print and the F&O tail. This is exactly the "one source of truth"
   failure CLAUDE.md warns about, and it is currently live.
3. **Freeze detection.** A spot that has not changed for 60 seconds after 15:15
   is in the auction, not stale. Label it in the UI rather than letting a
   trader read a frozen number as a live one.
4. **Zero time value after the auction locks.** On expiry day, treat
   time-to-expiry as 0 from the moment the auction print lands, not 15:41.
5. **Standing measurement.** Re-run the two tables above monthly from
   `DailyBar` + `WavePricePoint`. The convergence trend is the thing to watch;
   a claim about CAS made on five sessions has a short shelf life.
6. **Check whether Dhan exposes the indicative equilibrium price / imbalance.**
   Our index feed publishes one value at 15:15 and the next at ~15:29 — it does
   not carry the indicative. If Dhan has it, item 1 becomes direct rather than
   inferred. If not, item 1 is the only route.
7. **Backtest window definitions are stale.** `backtest-divergence-core.ts`
   buckets to 15:30 and `docs/index-option-selling-backtest.md` predates CAS.
   Any pre-Aug-2026 backtest of expiry-day short premium is measuring a
   settlement mechanism that no longer exists.

## Data gaps to close

- `DailyBar` stops at **2026-08-07**; `WavePricePoint` runs to **2026-08-14**.
  Run `scripts/bhavcopy-daily-topup.sh` to extend the official-close side, which
  is what validates everything here.
- Capture only ran to **15:30 IST until 2026-08-12**, when the session window
  moved to 15:41. Sessions from 3–11 Aug therefore have no 15:30–15:40 data —
  the parity trace above is only reproducible from 12 Aug onward.
- No NIFTY expiry day (Tuesday) in the local copy has full 15:15–15:41 capture:
  4 and 11 Aug predate the window change. **Today, Tuesday 18 Aug, is the first
  one** — run `scripts/sync-prod-db.sh` after 16:00 IST to pull it down.
