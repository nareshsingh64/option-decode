# Live Order module — design notes and recommendations

Status: **design only, nothing built.** This is the pre-implementation
reference for a new `/app/live-order` module that places **real orders on
Dhan**, modelled on Paper Trade Pro but routed to money.

It is written the way the rest of `docs/` is: what already exists and can be
reused, which constraints actually decide the design, and where the sharp
edges are. Numbers in here were read out of this repo on 2026-08-30, not
recalled.

## Decisions taken (2026-08-30)

Three questions from the first draft have been answered, and they are load-
bearing enough that the rest of the document is written around them:

| Decision | Consequence |
|---|---|
| **Multi-trader** — every user trades their own brokerage account | Per-user broker credentials, per-user token lifecycle, per-user rate budgets. §2.1, §2.2 |
| **`productType: "MARGIN"`** — carry-forward F&O, not `INTRADAY` | Every margin call and every order must pass it explicitly. The existing default is wrong for this module. §3.2 |
| **MCX in scope** — CRUDEOIL, NATURALGAS, COPPER, SILVER | A second exchange with a different session, different contract sizes, an unvalidated margin fallback, and devolvement-into-futures at expiry. §2.6 |

Still open: nothing. §12 now carries measured answers.

## Measured against the live Dhan account (2026-08-30)

Everything below is a **read-only** probe of the real brokerage account —
`fundlimit`, `positions`, the order book, and the margin calculator, which is a
static SPAN/exposure lookup with no side effects. **No order was placed.**
These numbers replace several assumptions in the first two drafts, and three of
them contradict what this document previously said.

| Probe | Result |
|---|---|
| Available balance | **₹1,27,539.85** (utilised ₹0, withdrawable ₹1,27,539.85) |
| Open position | NIFTY Sep2026 24800 CE, LONG 65, product **`MARGIN`** — so `MARGIN` is live and real on this account |
| BANKNIFTY 58000 CE short, qty 30, `MARGIN` | **₹1,78,392** (leverage 9.78×) |
| BANKNIFTY 58000 CE short, qty 30, `INTRADAY` | **₹1,78,392** — *identical* |
| BANKNIFTY 56500 CE short, qty 30, `MARGIN` | **₹2,22,711.60** (leverage 7.65×) |
| BANKNIFTY 58000 CE **BUY**, qty 30 | **₹4,500** = premium exactly (150 × 30), leverage 1× |
| CRUDEOIL 6500 PE short, qty **1** | **₹2,49,675** (leverage 2.62×) |
| CRUDEOIL 6500 PE short, qty **2** | ₹4,99,350 — exactly 2× |
| CRUDEOIL 6500 PE short, qty **100** | ₹2,49,67,500 — exactly 100× |
| `margincalculator/multi`, valid 2-leg basket | **all zeros**, `Currency: 0.0` |
| Super order book | endpoint reachable, account holds none |

Six findings, in order of how much they change the plan:

**(1) `MARGIN` and `INTRADAY` cost the same.** Identical to the rupee on the
same contract. §3.2 previously claimed `INTRADAY` understates the requirement
and that the default was therefore a live bug — **that was wrong**, and the
reasoning behind it (intraday leverage) does not apply to F&O short options
under peak-margin rules. The decision to use `MARGIN` still stands, for the
right reason: carry-forward, not auto-squared at the intraday cutoff. But it is
not a margin-accuracy fix and should not be sold as one.

**(2) `quantity` means different things on the two exchanges.** On `NSE_FNO` it
is **contracts** (qty 30 = one BANKNIFTY lot; leverage 9.78 × ₹1,78,392 =
₹17.4L = 58,000 × 30). On `MCX_COMM` it is **lots** (qty 1 = one CRUDEOIL lot
of 100; qty 100 gave a ₹2.5 **crore** requirement). Perfectly linear across
1 / 2 / 100, so this is the contract, not a fluke.

This is the single most dangerous finding here. Sending `lots * lotSize` to an
MCX order — the obvious thing to do, and what §4's schema implied — places an
order **100× too large**. It would not fail loudly; it would fill. Dhan's own
portfolio guidance hints at it ("use the multiplier, not lot size, for
`MCX_COMM`") and this is what that means in practice.

**(3) The 20% commodity fallback understates MCX margin by ~1.6×.** With
CRUDEOIL spot at 7,797 (last local capture, 2026-08-14):

| | model at 20% | measured | ratio |
|---|---|---|---|
| 6500 PE (OTM), 1 lot | ₹1,55,940 | **₹2,49,675** | 1.60× |
| 6000 CE (ITM by 1,797), 1 lot | ₹3,35,640 | **₹4,44,865** | 1.33× |

The model's *shape* (`basePct × spot + ITM amount`) fits well. Its
*coefficient* does not. Solving the OTM case gives **basePct ≈ 0.32**, which
reproduces it to within **0.07%** (0.32 × 7,797 × 100 = ₹2,49,504 vs ₹2,49,675)
and the ITM case to within 3.6%. So `MARGIN_BASE_PCT_COMMODITY = 0.32` is now a
*measured* constant rather than the guess §2.6(a) refused to invent — though it
is two strikes on one commodity on one day, and should be re-measured on
NATURALGAS, COPPER and SILVER before being trusted across MCX.

Note the direction: the current 20% **understates**, which flatters the account
— the harder error to notice, exactly as the rupees-vs-points bug was.

**(4) The `multi` endpoint returns zeros — cause found and FIXED (2026-08-30).**
A valid two-leg basket that prices
at ₹2,22,711.60 and ₹4,500 as singles comes back as `Total ₹0.00`, every
breakdown field zero, and `Currency: 0.0` — which is not even a currency. The
singles work perfectly. **The hedge-benefit derivation in §6.2 must therefore
run entirely off `single` calls**, which is what it already proposed as the
numeric method; what it cannot do is use `multi` for the basket term. **Resolved.** `calculateMultiOrderMargin()` sent `scripts` where Dhan wants
**`scripList`**, and `includeOrders` where Dhan wants **`includeOrder`**. Both
are fixed in `packages/dhan/src/index.ts`, guarded by
`packages/dhan/src/margin-calculator.test.ts` (6 tests; 3 of them fail against
the old names, verified by reverting).

Dhan's docs cannot settle this — the curl example and the structured spec on the
same page disagree with each other, exactly as they do for RenewToken. The
authority is the official Python client: `dhan-oss/DhanHQ-py`,
`src/dhanhq/_funds.py`, `margin_calculator_multi()` builds
`{ includePosition, includeOrder, scripList }`. Note `includePosition` is
singular and was always correct, sitting immediately beside a flag that was
wrongly plural — which is why the typo read as consistent and survived.

The corroborating evidence was already in the database: **195 `PaperOrder` rows
and 180 `PaperPosition` rows, every one with a NULL `marginRequired`.** Not
zero — never populated, not once, for the entire life of the feature. It failed
silently because both call sites wrap the call in a try/catch that logs at warn
and continues. That is correct behaviour for an informational figure, and it is
exactly what hid the bug: a rejected request looks identical to "Dhan was busy".

**The fix is not yet verified end to end.** The names are proven correct against
the official client; that the corrected call returns real numbers from Dhan is
not — it has not been run with live credentials. Until it is, keep deriving
hedge benefit from `single` calls, which are measured and working.

**(5) SPAN and exposure come back as zero on every call.** Only `totalMargin`
is populated. `LiveMarginView.requirement.span` / `.exposure` / `.fo` /
`.commodity` cannot be filled from this endpoint — the UI must show a single
total, or those fields must be dropped. Do not render a breakdown of zeros.

**(6) Long legs cost premium only.** ₹4,500 for a 150 × 30 buy, leverage 1×.
The hedge leg's cost model is therefore trivial and exact, which makes the
`marginalContribution` arithmetic in §6.2 well-posed.


---

## 1. What already exists (reuse map)

This is the most important section. Roughly **70% of a live-order module is
already in the tree** — it was built for the two paper modules and is not
paper-specific.

| Capability | Where it lives today | Reusable for live? |
|---|---|---|
| Dhan margin calculator, multi-leg | `packages/dhan/src/index.ts:407` `calculateMultiOrderMargin()` → `POST /v2/margincalculator/multi` | **Yes**, but product type and `includePosition` must change. §6 |
| F&O routing segment per symbol | `getFnoExchangeSegment()` (`packages/dhan/src/index.ts:64`) → `NSE_FNO` / `BSE_FNO` / `MCX_COMM` | **Yes, directly.** Already MCX-aware |
| Live WebSocket tick feed | `packages/dhan/src/live-feed.ts` `DhanLiveFeedClient` — additive/idempotent `subscribe()` | **Yes**, but it subscribes only `IDX_I` + `NSE_EQ` today, never an option contract. §7.2 |
| Redis tick cache | `apps/worker/src/live-tick-cache.ts` — merge-on-write, 45 s staleness, 90 s TTL, `MGET` batch | **Yes, as-is** |
| SSE transport | `apps/api/src/server.ts:1022` `/api/market/stream` — `reply.hijack()`, client registry, 15 s heartbeat, `retry: 5000` | **Yes, as a pattern** |
| Per-user isolation pattern | `/api/sim/*` — **no route takes a userId**, every one resolves the caller from the session cookie | **Copy exactly.** §9.1 |
| Strategy quoting / liquidity gate | `quoteSimTrade()` (`sim-repository.ts:496`) — OI ≥ 500, spread ≤ 15%, slippage χ 0.25 / 0.50 | **Pre-trade sanity yes**, fills no — the broker fills, not us. MCX thresholds need re-checking, §2.6 |
| Exit rules | `sim-repository.ts` — `PROFIT_TARGET`, `HARD_STOP_3X`, `DTE_GAMMA`, `DELTA_2X_INTRADAY`, `EXPIRY_ITM`, `DELIVERY_RISK` | **Yes, after extraction.** §8.2 |
| Multi-leg hedge grouping | `PaperOrder.groupId` / `legRole`, `getOpenPositionsForMarginGroup()` | **Yes** — same shape works for live baskets |
| Margin persisted per group | `recordOrderMargin()` / `recordPositionMargin()`, `marginRequired` + `marginBreakdown` JSON | **Yes** |
| Short-leg margin model | `shortLegMarginPerUnit()` (`packages/types/src/index.ts:563`) | **Fallback only, and NOT valid on MCX.** §2.6 |
| securityId resolution | `OptionContract.securityId` (`@@index([securityId])`) + `latestTick.securityId` | **Yes.** §6.3 |
| Session times per exchange | `NSE_SESSION_*` 09:14–15:41, `MCX_SESSION_*` **09:00–23:30**, `MCX_UNDERLYINGS`, `getSessionCloseIstMinutes()` | **Yes, directly.** Already correct for both exchanges |
| Expiry settlement per exchange | `expirySettlementMoment()`, worker passes at 15:45 and **23:40** IST | **Yes** — built after the CRUDEOIL incident |
| Lot sizes | `FALLBACK_LOT_SIZES` — NIFTY 65, SENSEX 20, CRUDEOIL 100, NATURALGAS 1250, COPPER 2500, SILVER 30 | **Yes**, and see §2.6 on why lots are the wrong unit for caps |
| JWT expiry decode | `assertAccessTokenIsUsable()` (`packages/dhan/src/index.ts:870`) | **Yes** for the per-user expiry countdown — with the `exp`-can't-know-revocation caveat |
| Dhan call audit | `DhanApiRequestLog` (endpoint, caller, statusCode, durationMs) | **Yes** — live orders need it more, not less |
| Token renewal decision logic | `ops/scripts/dhan-token-renew.sh` — preflight, 5xx probe, verify-then-persist | **Logic yes, script no.** Must be ported to a per-user job. §2.2 |
| Ticket derivation from signals | `apps/web/src/components/sim-ticket-draft.ts` | **Yes, unchanged.** §8.1 |
| Tab registration | `DashboardView` (`live-dashboard.tsx:464`), `app-shell.tsx:18`, `app/page.tsx:29`, `admin-panel.tsx:20` | Add `"live-order"` in those four places |

**What does not exist and must be written:**

- Any order placement. `packages/dhan/src/index.ts` is read-only plus the
  margin calculator — no `/v2/orders`, no order book, no positions, no funds.
- `postDhan()` is **POST-only** (`packages/dhan/src/index.ts:456`). The order
  surface needs GET (order book, positions, fundlimit) and PUT/DELETE
  (modify, cancel). Generalising that choke point is Phase 0 work, and it must
  stay a single choke point so `DhanApiRequestLog` keeps seeing everything.
- Any per-user credential storage, encryption, or renewal.
- Any notion of a brokerage position as distinct from a simulated one.
- Any kill switch, notional cap, or reconciliation loop.

---

## 2. The constraints that actually decide the design

### 2.1 Multi-trader: per-user broker credentials

**Decided.** Every user trades their own Dhan account. This is the right call
for the product and it is the single biggest piece of new work.

Today `DHAN_CLIENT_ID` / `DHAN_ACCESS_TOKEN` are single env scalars
(`packages/config/src/index.ts:12`) and every Dhan call is the app's own
account. That does not go away — it splits in two:

| Call class | Credential | Why |
|---|---|---|
| Market data: option chains, LTP/OHLC/quote, scrip master, the WebSocket feed | **App account** (env, unchanged) | Shared data. One capture serves every user. Nothing here is account-specific |
| Orders, order book, positions, trades, funds, **margin** | **The user's own credential** | Account-specific by definition. Margin especially — it depends on what *that* account already holds |

This split is not a nicety. If margin were computed on the app account it
would net the requirement against the app account's positions and return a
number that is wrong for the user in both directions.

```prisma
model UserBrokerCredential {
  id             String   @id @default(cuid())
  userId         String
  broker         String   @default("DHAN")
  brokerClientId String                        // dhanClientId, stored plain — it is not a secret
  // AES-256-GCM. Never logged, never returned by any route, never emailed.
  tokenCipher    Bytes
  tokenIv        Bytes
  tokenTag       Bytes
  keyVersion     Int      @default(1)          // lets the encryption key be rotated
  // Decoded from the JWT at save time so expiry can be listed without
  // decrypting anything. An `exp` cannot know the token was revoked
  // server-side, so this is a hint, not proof — see verifiedAt.
  tokenExpiresAt DateTime?
  // Last time this credential actually answered 200 on /v2/fundlimit.
  verifiedAt     DateTime?
  verifiedOk     Boolean  @default(false)
  // A partner-minted token cannot be renewed. Refuse it at save time
  // rather than discovering it at 08:17 on a Monday.
  renewable      Boolean  @default(false)
  lastRenewalAt  DateTime?
  lastRenewalMsg String?  @db.VarChar(255)
  revokedAt      DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([userId, broker])
  @@index([tokenExpiresAt])
}
```

Rules that must hold, and are cheap to hold from day one:

- **The token never leaves the server.** No route returns it, not even to its
  owner, not even masked beyond a last-4. `GET /api/live/credential` returns
  `{ brokerClientId, tokenExpiresAt, verifiedOk, renewable }` and nothing else.
- **The token never enters a log or an email.** CLAUDE.md already records why:
  a JWT in an inbox is a live credential, and mail is forwarded and archived.
  The one exception in the renewal *script* — logging the token untruncated on
  the failure path, because it may be the only copy in existence — does **not**
  transfer to a multi-user server. There, recovery is "the user pastes a new
  one", which is a path the script never had.
- **Encryption key in `LIVE_BROKER_ENCRYPTION_KEY`**, 32 bytes, in
  `.env.production` only. `keyVersion` on the row so it can be rotated without
  a migration. Note `.env.production` **cannot be sourced by bash** (line 31,
  `EMAIL_FROM` is unquoted and contains `<`) — any ops script touching this
  must `grep -m1` the value out, as the index-drop runbook learned the hard way.
- **Refuse a partner-minted token at save time.** Only a token minted from Dhan
  Web (`tokenConsumerType: SELF`, empty `partnerId`) can be renewed. The
  renewal script's preflight already refuses one rather than burning it; do the
  same check on paste, when the user is still at the keyboard and can fix it.
- **Per-user `DhanClient` instances are cheap** — the constructor takes options
  and opens nothing (`packages/dhan/src/index.ts:238`). Cache them in a `Map`
  keyed by `userId`, invalidated on credential update. Do **not** construct one
  per request; `onRequest` wiring and the JWT assert would be re-done every time.

**One upside worth stating:** Dhan rate limits are per account. Today every
user's activity shares one budget — the LTP/OHLC **1 request/second combined**
limit is already why `getFreshMarketAuxData` sleeps 1.1 s between calls. Under
multi-trader, each user's order/margin/position traffic draws on their own
budget. The shared app account keeps only the market-data load it already has.
Multi-trader is *better* for rate limits, not worse.

### 2.2 The hard part of multi-trader is the 24-hour token, per user

This is the cost of the decision, stated plainly so it can be planned for
rather than discovered.

What is automatable: `GET /v2/RenewToken` extends an **active** token by
another 24 h. That works per user exactly as it works for the app account.

What is not: minting a token requires an interactive browser login with 2FA at
web.dhan.co. **An expired token cannot be renewed, only regenerated.** So every
user must paste a token at least once, and again after every expiry.

**The weekend hole applies to every user.** The box is off Friday 23:50 to
Monday 08:15 — **56.5 hours against a 24-hour token**. On an ordinary weekend
every live-trading user needs a Sunday-evening paste. On a maintenance weekend
(box running, Sunday 17:30 renewal cron) nobody does. That asymmetry is already
documented for the app account; it now multiplies by user count.

**Recommendations:**

1. **Port the renewal decision logic into a worker job, per credential** — do
   not shell out to `dhan-token-renew.sh` N times. That script's *reasoning* is
   the valuable part and must be preserved exactly:
   - Preflight `/v2/fundlimit` — an `exp` claim cannot know a token was revoked.
     A 4xx stops the run; a 5xx must **not** block a legitimate renewal.
   - After RenewToken returns 200 **the old token is already dead**, so the new
     one is the only credential in existence. A 5xx on the verify call is
     retried, then persisted anyway as `SUCCESS (UNVERIFIED)`. Discarding it is
     the destructive act.
   - A 5xx on RenewToken itself is ambiguous: probe the **old** token against
     `/v2/fundlimit`. Still authenticates ⇒ renewal did not happen ⇒ retry.
     Does not ⇒ it did ⇒ stop, manual action, do not retry into a wall.
   - Dhan unreachable with the token intact is `NO ACTION NEEDED`, not FAILED.
2. **Stagger the per-user runs.** The app account's four cron times exist to
   dodge the boot prune, market hours, and the shutdown. N users renewing at
   08:17 is a burst against Dhan and against our own 2-vCPU box. Spread them
   across a window (e.g. 08:17–08:32, deterministic by `userId` hash) and keep
   the same `--threshold-hours 25` logic so a renewal is unconditional and the
   clock resets early.
3. **`--no-restart` semantics are now automatic.** The app-account script
   restarts api+worker so running services pick up the new token from the env
   file. Per-user tokens live in the database and are read per request — there
   is **nothing to restart**. This removes the single most dangerous coupling in
   the current design: the 08:17 renewal restarting the worker mid-prune is what
   caused the three-hour rollback on 2026-08-20.
4. **Self-service paste UI plus a Sunday reminder.** A credential page where the
   user pastes a fresh token, it is validated against `/v2/fundlimit` **before**
   being persisted, and the renewability check runs. Email every user with a
   live credential on Sunday at ~17:00 IST if their token will not survive to
   Monday's open. Send it from the app's GoDaddy mailbox — the domain publishes
   `p=quarantine` with a hard-fail `-all` SPF, so any other sender is
   quarantined until the DNS record changes.
5. **Entry gate on token health.** Refuse to *open* a position when the token
   has < 2 h of life or `/v2/fundlimit` does not answer 200. **Always allow
   exits.** An expired token means you cannot close either, which is the whole
   risk.
6. **A dead token with positions open is a `MANUAL ACTION REQUIRED` email**, per
   user, with the position list. Alerting hangs off the failure path so every
   route to it is covered.

### 2.3 The box is off 23:50 → 08:15 IST

A stop-loss that lives in our worker **does not exist overnight**, nor during
the ~40 minutes after boot when the retention prune is grinding MySQL.

For MCX this is better than it looks and worth being precise about: MCX trades
09:00–23:30 and the box is up 08:15–23:50, so the **entire MCX session is
covered**. The exposure is a position *carried across days*, which is
unmonitored 23:30→09:00 but during which MCX is also closed. NSE F&O to 15:41
is likewise well inside the window.

The real overnight risk is therefore gap risk on a carried position, not
in-session monitoring — but a broker-side stop still beats ours, because it
also survives our process crashing, our token expiring, and our host failing to
boot.

**Recommendation: put the stop at the broker.** Dhan's Super Order carries
entry + target + stop-loss + trailing jump as one server-side object
(`super_place` / `super_modify` / `super_cancel`, legs `ENTRY_LEG`,
`TARGET_LEG`, `STOP_LOSS_LEG`). Our own rule engine becomes a second layer, not
the only one. Whether Super Orders accept F&O option legs — and with which
product types, given `MARGIN` is now required — is open question §12.2.

**One collision to design around:** the boot-time retention prune starts 08:35
IST and runs ~40 minutes, i.e. to roughly **09:15**. MCX opens at **09:00**. A
live module that reads MySQL in its hot loop will do so during the first
fifteen minutes of the MCX session, against a box already saturated. §7 keeps
the live path on Redis specifically so this does not matter.

### 2.4 Refresh latency today is 30–60 s, and the exit engine is worse

Measured from the code path, not guessed:

```
Dhan → option-chain REST capture      every 30 s   (SNAPSHOT_INTERVAL_MS)
      → OptionContractTick rows in MySQL
      → getLatestLegTick() per leg     on request  (4-way concurrency, pool is 10)
      → /api/sim/summary
      → panel polls                    every 30 s  (paper-trading-pro-panel.tsx:489)
```

Worst case a mark on screen is **~60 s old**; median ~45 s. Fine for a
simulator. Not acceptable for a live position with a 3×-credit stop.

The intraday exit engine is worse: `runSimIntradayEngine` samples at
`INTRADAY_MTM_SAMPLE_MS = 5 * 60 * 1000` — **five minutes**. A hard stop
evaluated every five minutes is not a stop.

§7 is the answer.

### 2.5 Units, and the close

- **`quantity` is contracts, not lots.** `quantity = lots * lotSize`. A wrong
  lot size never fails loudly — it silently rescales every rupee figure.
- **Rupees are not points.** Charging ₹20 brokerage against a points-denominated
  P&L was a real bug here. Live P&L is denominated in **rupees end to end**;
  points are display only. This matters more with MCX in scope, where a "point"
  means four different things across four contracts.
- **The close is an auction (CAS).** Spot freezes at 15:15 and steps once at
  ~15:29; NSE F&O keeps trading to 15:40. A stop keyed off *spot* stops updating
  at 15:15 while the option you are short keeps moving. **Key live stops off the
  option's own LTP.** Also note `apps/api/src/server.ts:2219` still hardcodes a
  15:30 close in a private duplicate of `isMarketSessionOpen` — do not build a
  live session gate on that call site; use `getSessionCloseIstMinutes()`.

### 2.6 MCX in scope — what it actually changes

**Decided: CRUDEOIL, NATURALGAS, COPPER, SILVER are live-tradeable.** The
plumbing is largely there — `getFnoExchangeSegment()` returns `MCX_COMM`,
`MCX_SESSION_*` and `getSessionCloseIstMinutes()` are correct, the 23:40 EOD
settle pass exists, and the margin result already carries `commodityMargin`.
Five things do not transfer, and three of them are traps.

**(a) The margin fallback is invalid on MCX — now measured, not just suspected.**
`INDEX_MARGIN_UNDERLYINGS` (`packages/types/src/index.ts:541`) lists only the
seven indices plus INDIAVIX. All four commodities fall through to
`MARGIN_BASE_PCT_STOCK` = **20%** — a figure whose own doc comment says it is
"designed for single stocks" and warns against reusing it elsewhere. Nobody
chose 20% for crude oil; it is what the `else` branch returns.

Measured against the live calculator (full numbers in the Measurements section
above): the 20% figure **understates CRUDEOIL margin by ~1.6× on an OTM strike**,
and the coefficient that actually fits is **≈ 0.32**, reproducing the OTM case
to within 0.07%.

Recommendations, now that there is a number:

- Add `MARGIN_BASE_PCT_COMMODITY = 0.32` **only after re-measuring on
  NATURALGAS, COPPER and SILVER.** Two strikes on one commodity on one day is
  enough to prove 20% is wrong; it is not enough to bless 32% across MCX.
- On the live path, still **require a real Dhan figure for MCX** and refuse the
  order if the calculator fails. The commodity constant is a cross-check and an
  offline-estimate, never the thing an order is sized against.
- `packages/types/src/margin.test.ts` asserts the index/stock split. Add an
  assertion that MCX symbols do not silently resolve to the stock figure — a
  test that fails today is the correct way to record this.

Note the direction: 20% **understates**, which flatters the account. That is the
harder error to notice, and it is the same failure mode as the rupees-vs-points
bug that survived review because it looked conservative.

**(b) Lots are the wrong unit for risk caps.** One lot means:

| Underlying | Lot size |
|---|---|
| SENSEX | 20 |
| SILVER | 30 |
| NIFTY | 65 |
| CRUDEOIL | 100 |
| NATURALGAS | 1250 |
| COPPER | 2500 |

A `maxLotsPerOrder = 2` cap is meaningless across that range — it permits two
wildly different risks depending on the symbol. **Caps must be expressed in
rupees of notional and rupees of margin**, computed at preview time, with an
optional per-underlying lot ceiling on top. This is a direct correction to the
first draft of the schema in §4.

**(c) `quantity` is LOTS on MCX and CONTRACTS on NSE. This is the trap.**
Measured, linear across qty 1 / 2 / 100: on `MCX_COMM` a `quantity` of 1 is one
whole CRUDEOIL lot (100 barrels). On `NSE_FNO`, a `quantity` of 30 is one
BANKNIFTY lot of 30 contracts.

So the obvious formula — `quantity = lots * lotSize`, which §4 originally
implied and which is correct for NSE — sends an MCX order **100× too large**.
It would not error. It would fill, at a requirement of ₹2.5 crore against an
account holding ₹1.27 lakh.

**Recommendation:** a single `toBrokerQuantity(underlyingSymbol, lots)` helper
in `@option-decode/types`, beside `getFallbackLotSize()`, that returns
`lots * lotSize` for NSE/BSE and `lots` for MCX — with a unit test per exchange
asserting both branches. Never compute quantity inline at a call site. This is
the same "one definition, imported" convention that `FALLBACK_LOT_SIZES` exists
to enforce, and it is the highest-consequence place in this module to break it.

Dhan's own portfolio guidance also says to use the **multiplier** rather than
lot size for `MCX_COMM`, and to read `costPrice` rather than `buyPrice`. Store
`multiplier` on `LivePosition` and use it for MCX P&L. Both are easy to get
wrong and neither fails loudly — they produce plausible numbers.

**(d) Expiry means devolvement into a futures position, not cash settlement.**
MCX options are options *on futures*. An ITM short left to expire does not
settle in cash — it becomes a futures position carrying full futures margin,
and MCX futures ultimately go to physical delivery of a commodity. This is a
materially worse tail than the stock-option delivery risk the sim already flags
via `DELIVERY_RISK`.

**Recommendation: force-close, don't flag.** For MCX shorts, the
`DELIVERY_RISK` rule should be a **hard auto-exit** with a configurable lead
time (default: close by 15:00 IST on expiry day, well before the 23:30 close),
not a UI flag the user may not see. Confirm the exact devolvement and margin-
ramp mechanics against a live account before setting the lead time — this is
the one MCX behaviour worth verifying empirically rather than reasoning about.

Note also that `isIndexUnderlying()` in `sim-repository.ts:49` excludes the
commodities, so today they already take the stock path for `DTE_GAMMA` and
`DELIVERY_RISK`. That is accidentally close to right, but it is accidental.

**(e) The liquidity gate needs re-checking for MCX.** `quoteSimTrade` refuses
OI < 500 and spread > 15%. Those thresholds were chosen against NIFTY-scale
chains. Whether MCX option chains clear them is unmeasured — if they do not,
every MCX ticket will be refused; if they are far too loose, a market order
will get a terrible fill. Measure the OI and spread distributions on the four
commodities from captured `OptionContractTick` history before enabling MCX
entries, and make the thresholds per-exchange rather than global.

**(f) The 23:40 settle pass has ten minutes of margin.** `sim-eod-mtm:mark-mcx`
runs at 23:40 IST against a 23:50 shutdown. That was five minutes until the
EventBridge stop moved on 2026-08-20, precisely because five was too thin.
**Any live-order work added to that pass eats into ten minutes.** Live MCX
settlement/reconciliation should run at 23:35, immediately after the 23:30
close and before the existing pass, rather than being bolted onto it.

---

## 3. Dhan v2 order contract

Taken from the Dhan MCP tool definitions available in this workspace, which are
generated from the live API. **Verify each against a real account before
shipping** — the RenewToken episode is the standing reminder that Dhan's
published docs and its actual behaviour differ.

### 3.1 Endpoints

```
POST /v2/orders            place
PUT  /v2/orders/{orderId}  modify
DEL  /v2/orders/{orderId}  cancel
POST /v2/super/orders      place with target + SL + trailing
GET  /v2/orders            order book (today)
GET  /v2/orders/{orderId}  single order
GET  /v2/super/orders      super order book incl. leg detail
GET  /v2/positions         open positions
GET  /v2/fundlimit         available margin / fund limit
GET  /v2/trades            today's executed trades
```

```jsonc
// place
{
  "dhanClientId": "…",              // the USER's, from their credential
  "transactionType": "BUY|SELL",
  "exchangeSegment": "NSE_FNO|BSE_FNO|MCX_COMM",   // getFnoExchangeSegment()
  "securityId": "…",                // OptionContract.securityId
  "quantity": 65,                   // CONTRACTS = lots * lotSize
  "orderType": "LIMIT|MARKET|STOP_LOSS|STOP_LOSS_MARKET",
  "productType": "MARGIN",          // §3.2 — decided
  "price": 128.5,                   // 0 for MARKET
  "triggerPrice": 0,                // STOP_LOSS only
  "validity": "DAY|IOC"
}
```

Super order adds `targetPrice`, `stopLossPrice`, `trailingJump`.

### 3.2 `productType: "MARGIN"` — decided, and measured

`MARGIN` is carry-forward F&O: positions survive the session instead of being
auto-squared at the intraday cutoff. That is the correct product for a seller
module and for anything held to expiry. The account already holds a `MARGIN`
position, so the product is live and accepted.

**Correction to earlier drafts.** This document previously claimed that the
client's `productType ?? "INTRADAY"` default understates margin and was
therefore a latent bug. Measured on the same contract, `MARGIN` and `INTRADAY`
return **the identical figure** (₹1,78,392 both ways). Intraday leverage does
not apply to F&O short options under peak-margin rules. So:

- The default is **not** producing wrong margin numbers today.
- `MARGIN` is still the right choice, for the correct reason: carry-forward.
- It is still worth making `productType` **explicit and required** on the live
  path — not because the number changes, but because the *product* changes, and
  an order silently placed as `INTRADAY` would be auto-squared off at the
  intraday cutoff. That is a position-management failure, not a margin one, and
  it is arguably worse: the trader loses the position rather than mis-sizing it.
- **Do not change the paper modules' default.** Since the figure is identical,
  there is now no margin reason to, and changing it would alter what the
  simulator models for no measured benefit.

### 3.3 Client-level notes

- `headers()` sends `client-id`. RenewToken needed `dhanClientId` instead.
  **Do not assume the order endpoints take the same header as the market-data
  ones** — probe it. This is a 30-second check that has already cost this repo
  real time once.
- `postDhan()` is POST-only with a **4-second default timeout**
  (`requestTimeoutMs ?? 4_000`). For order placement 4 s is too aggressive: a
  timeout leaves you in the UNKNOWN state, which is the worst state there is
  (§9.3). Use ~10 s for placement specifically, and keep market data at 4 s.
- `correlationId` — Dhan accepts a caller-supplied id on orders. Use it. It is
  the only thing that makes a retry safe.
- Everything must keep routing through the one audited choke point so
  `DhanApiRequestLog` sees it. Add `userId` to the audit event for this module;
  under multi-trader, "which account made this call" is the first question any
  investigation will ask.

---

## 4. Proposed data model

Additive only, mirroring how `Sim*` was added beside `Paper*` without touching
either. Prefix `Live`. `UserBrokerCredential` is in §2.1.

```prisma
model LiveAccount {
  id             String   @id @default(cuid())
  userId         String
  brokerClientId String                 // denormalised from the credential
  isActive       Boolean  @default(true)
  tradingEnabled Boolean  @default(false)   // per-account kill switch

  // Caps are in RUPEES, not lots — see §2.6(b). One lot is 20 contracts on
  // SENSEX and 2500 on COPPER; a lot-denominated cap is not a risk limit.
  // MARGIN, not notional: a spread's notional is huge and its risk is not.
  // Values in §12.3, sized against a measured ₹1,27,539.85 balance.
  maxOrderMargin       Decimal @db.Decimal(16, 2)   // ₹40,000
  maxOpenMargin        Decimal @db.Decimal(16, 2)   // ₹60,000
  dailyLossLimit       Decimal @db.Decimal(16, 2)   // ₹5,000
  maxMarginUtilPct     Decimal @default(50.00) @db.Decimal(5, 2)
  maxOrdersPerMinute   Int     @default(6)
  // Blocks naked/undefined-risk structures outright, not merely by cap.
  allowUndefinedRisk   Boolean @default(false)
  // Optional per-underlying lot ceiling ON TOP of the rupee caps.
  lotCeilings          Json?              // { "CRUDEOIL": 1, "NIFTY": 4 }
  @@unique([userId, brokerClientId])
}

model LiveOrder {
  id              String   @id @default(cuid())
  accountId       String
  groupId         String?           // multi-leg basket, mirrors PaperOrder.groupId
  legRole         String   @default("MAIN")
  correlationId   String   @unique  // idempotency key sent to Dhan
  brokerOrderId   String?  @unique  // set once Dhan answers
  underlyingSymbol String
  expiryLabel     String
  optionType      OptionType
  strikePrice     Decimal  @db.Decimal(12, 2)
  securityId      String
  exchangeSegment String            // NSE_FNO | BSE_FNO | MCX_COMM
  transactionType String            // BUY | SELL
  productType     String            // "MARGIN" — stored, never defaulted
  orderType       String
  lots            Int
  lotSize         Int               // snapshot at placement; never re-derived
  // What was ACTUALLY sent to the broker. NSE/BSE: lots * lotSize.
  // MCX: lots. See §2.6(c) - getting this wrong is a 100x order.
  // Always via toBrokerQuantity(), never computed inline.
  quantity        Int
  notional        Decimal  @db.Decimal(16, 2)
  price           Decimal? @db.Decimal(12, 2)
  triggerPrice    Decimal? @db.Decimal(12, 2)
  status          LiveOrderStatus   // LOCAL_PENDING|SENT|OPEN|PARTIAL|TRADED|CANCELLED|REJECTED|UNKNOWN
  brokerStatusRaw String?  @db.VarChar(64)
  rejectionReason String?  @db.VarChar(255)
  filledQty       Int      @default(0)
  avgFillPrice    Decimal? @db.Decimal(12, 2)
  // What the user was shown when they confirmed (§5, two-phase placement).
  quotedAt        DateTime?
  quotedPrice     Decimal? @db.Decimal(12, 2)
  quotedMargin    Decimal? @db.Decimal(16, 2)
  signalRef       String?           // Strike Matrix attribution, as SimTrade has
  placedAt        DateTime @default(now())
  @@index([accountId, status])
  @@index([groupId])
}

model LiveOrderEvent {              // append-only audit; never updated
  id         String   @id @default(cuid())
  orderId    String
  source     String                 // API_RESPONSE | WS_UPDATE | RECONCILE | LOCAL
  status     String
  payload    Json
  observedAt DateTime @default(now())
  @@index([orderId, observedAt])
}

model LivePosition {
  id            String  @id @default(cuid())
  accountId     String
  groupId       String?
  securityId    String
  underlyingSymbol String
  exchangeSegment  String
  // …contract identity…
  netQty        Int                        // signed; short is negative
  avgCostPrice  Decimal @db.Decimal(12, 2) // Dhan: costPrice, NOT buyPrice
  lotSize       Int
  multiplier    Int?                       // MCX_COMM uses this, not lotSize (§2.6c)
  lastPrice     Decimal? @db.Decimal(12, 2)
  unrealizedPnl Decimal? @db.Decimal(14, 2)
  realizedPnl   Decimal  @default(0) @db.Decimal(14, 2)
  status        LivePositionStatus
  reconciledAt  DateTime
  @@index([accountId, status])
}

model LiveMarginSnapshot {           // §6
  id        String   @id @default(cuid())
  accountId String
  asOf      DateTime
  source    String                   // DHAN | MODEL
  payload   Json                     // the LiveMarginView
  @@index([accountId, asOf])
}
```

Load-bearing details:

- **`lotSize` and `multiplier` are stored on the row.** Stored
  `OptionContractTick` rows carry no lot size, and `FnoLotSize` varies by
  contract month. An order's rupee value must be reconstructible years later
  from the row alone.
- **`notional` is stored**, because the caps are in rupees and recomputing it
  later from a lot size that has since changed would give a different answer.
- **`productType` is stored, never defaulted** (§3.2).

---

## 5. API surface

Same isolation rule as `/api/sim/*`: **no route takes a userId.** Every one
resolves the caller from the session cookie. Under multi-trader this stops
being a nicety and becomes the thing that prevents one user routing an order
into another user's brokerage account.

```
GET    /api/live/credential          { brokerClientId, tokenExpiresAt, verifiedOk, renewable } — never the token
PUT    /api/live/credential          paste/replace; validated against /v2/fundlimit BEFORE persisting
DELETE /api/live/credential          revoke

GET    /api/live/summary             account, positions, working orders, margin, P&L — initial state only
GET    /api/live/stream              SSE — the fast channel (§7)
POST   /api/live/preview             price + margin a basket, returns a confirmToken
POST   /api/live/orders              place; body must carry the confirmToken
PATCH  /api/live/orders/:id          modify (price / trigger / qty)
DELETE /api/live/orders/:id          cancel
POST   /api/live/positions/:id/exit  square off one position
POST   /api/live/panic               cancel all working orders + square off all
GET    /api/live/margin              the margin object (§6), cached
GET    /api/live/reconcile           on-demand diff vs Dhan (also runs on a timer)
```

Admin oversight goes in `/api/admin/live/*` behind `requireAdminUser` and is
**read only**, exactly as `/api/admin/sim/*` is. Under multi-trader admins need
one genuinely new read: **credential health across users** — who has a token
expiring, who failed their last renewal, who has open positions with a dead
token. That view must show expiry and status and **never the token itself**.

There must be no endpoint that places, modifies, or closes another user's live
position. Its absence is the guarantee, not the UI.

**Two-phase placement is the point of `/preview`.** It returns the quote, the
margin, and a short-lived signed `confirmToken` binding
`(userId, legs, prices, margin, asOf)`. `/orders` refuses a token older than
~10 s, one bound to a different user, or one whose price has moved past a
tolerance. This is what stops a user confirming a ticket that went stale in a
tab, and it costs one extra round trip.

---

## 6. The margin object

Dhan's calculator is already wired up. What is missing is a **view** that puts
requirement, availability, and hedge benefit in one place — and under
multi-trader, one that is computed with the **user's own** credential.

### 6.1 Shape

```ts
export interface LiveMarginView {
  asOf: string;
  source: "DHAN" | "MODEL";     // MODEL = fallback estimate; NEVER for MCX (§2.6a)
  productType: "MARGIN";        // stated, because it changes the number (§3.2)
  stale: boolean;

  // GET /v2/fundlimit — the user's account
  funds: {
    availableBalance: number;
    utilizedAmount: number;
    withdrawableBalance: number;
    collateralAmount: number;
    blockedPayoutAmount: number;
  };

  // MEASURED: only `total` is populated. span/exposure/fo/commodity all
  // came back 0.00 on every probe, and `multi` returned zeros outright.
  // Build these off `single` calls, and render ONLY what is non-zero -
  // a breakdown of zeros reads as "no margin", which is the opposite of true.
  requirement: {
    total: number;
    span: number | null; exposure: number | null;
    fo: number | null; commodity: number | null;   // commodity = the MCX half
    currency: string;
  };

  // Dhan's own shortfall against real available funds - accounts for
  // collateral and blocked payouts we do not model. This is the headroom
  // gate; our caps are a second, tighter one. Non-zero => refuse.
  insufficientBalance: number;

  hedge: {
    grossMargin: number;      // Σ per-leg margin, each priced alone
    netMargin: number;        // the basket priced as one request
    benefitAmount: number;    // gross - net
    benefitPct: number;
    brokerText?: string;      // Dhan's own hedge_benefit string, verbatim
    legs: Array<{
      securityId: string; optionType: "CE" | "PE"; strikePrice: number;
      transactionType: "BUY" | "SELL"; quantity: number;
      exchangeSegment: string;
      standaloneMargin: number;
      marginalContribution: number;    // basket-with-leg minus basket-without
      role: "RISK" | "HEDGE";          // marginalContribution < 0 ⇒ HEDGE
    }>;
  };

  perGroup: Array<{
    groupId: string; structure: string; exchangeSegment: string;
    netMargin: number; benefitAmount: number; maxLoss: number | null;
  }>;

  headroom: {
    free: number;                  // availableBalance - requirement.total
    utilizationPct: number;
    pendingTicketMargin: number | null;
    wouldBreach: boolean;          // against maxMarginUtilPct
  };

  modelCrossCheck: {               // sanity only, and absent for MCX
    available: boolean;
    estimate: number | null;
    lowBand: number | null; highBand: number | null;
    divergencePct: number | null;
  };
}
```

### 6.2 How to actually get the hedge benefit

The current client returns `hedgeBenefit?: string` — a **string** from
`raw.hedge_benefit`. Fine to display verbatim, useless to compute with, and it
may not be present on every response.

**Derive it numerically:**

```
grossMargin = Σ over legs of  multi([leg])        // N calls, one leg each
netMargin   = multi(all legs together)            // 1 call
benefit     = grossMargin - netMargin
```

and for per-leg attribution:

```
marginalContribution(leg) = multi(all legs) - multi(all legs except leg)
```

That is N+1 calls for the basket total and 2N+1 with attribution — **9 Dhan
calls for a four-leg condor**, per user. Three fixes:

1. **Cache hard.** The calculator is a static SPAN/exposure lookup, not a live
   quote — which is why the paper module's estimate works outside market hours.
   Cache **per user** (the answer depends on their existing positions once
   `includePosition: true`) keyed on
   `(userId, securityIds, quantities, sides, productType, roundedPrice)`, 60 s
   TTL, invalidated when the underlying moves more than ~0.25% or any fill
   lands. One basket then costs ~9 calls **once** and 0 thereafter.
2. **Compute attribution on demand.** The summary needs `benefitAmount`; only
   the expanded drill-down needs `legs[]`. Do not pay 2N+1 on every refresh.
3. **Set `includePosition: true` AND `includeOrders: true` for live.** The
   current call hardcodes both to `false`. For a simulator that is right — you
   want the standalone cost of a hypothetical. For live money it is wrong: it
   ignores relief against what the account already holds, which is the main
   source of margin benefit for a book of short strangles, and it ignores
   margin already blocked by working orders.

**Sanity floor:** benefit can never exceed `grossMargin`, and SPAN for a hedged
basket is ≥ 0. If a computed benefit exceeds ~60% of gross, treat it as suspect
and mark `stale: true` rather than showing a number that gets someone
over-leveraged. Real margin is SPAN + Exposure revalued by the exchange **six
times a trading day** — nothing here is exact, and the view should say so.

**MCX-specific:** `requirement.commodity` is the MCX half and should be shown
separately, not folded into a single total. A user with both an NSE condor and
a CRUDEOIL strangle has two independent margin pools with no offset between
them, and a single blended number hides that.

### 6.3 securityId resolution

Every margin and order call needs `securityId`. Three sources, in order:

1. `OptionContract.securityId` — indexed, one query, covers any contract the
   chain capture has seen.
2. Latest `OptionContractTick.securityId` (what the paper module uses).
3. Dhan's scrip master — **34 MB / ~203k rows, ~0.4 s from EC2 plus parsing**.
   Never in a request path; warm at boot like `warmOverviewCaches()`. It is also
   the only source that resolves MCX contracts, which is exactly why it is
   downloaded today.

If none resolves, **refuse the order.** The paper module logs a warning and
continues without a margin figure; a live module cannot place an order it
cannot name.

---

## 7. Refresh latency — the architecture

Targets, stated so they can be measured against:

| Signal | Today (paper) | Target (live) |
|---|---|---|
| Order status change | n/a | **≤ 5 s** (poll; see §12.1) |
| Open position mark | 30–60 s | **< 1.5 s** in session |
| Margin / funds | on request, uncached | **≤ 5 s**, cached |
| Exit-rule evaluation | 5 min | **on tick, < 2 s** |
| Reconcile vs broker | n/a | 30 s idle, 5 s while an order works |

### 7.1 Tier 1 — order state comes from the broker, pushed

Dhan publishes an order-update WebSocket. **Verify the endpoint and auth shape
against a live account before designing on it** (§12.1). If it works it is the
correct source for `SENT → OPEN → TRADED/REJECTED` and removes polling for the
common case.

Under multi-trader this is **one socket per user with a live credential**, since
the stream is account-scoped. That is a real resource question: N sockets, each
needing reconnect/backoff and each dying when its user's token expires. Budget
for it, cap the number of concurrent live-trading users in phase 1, and make
socket lifecycle follow credential validity.

Regardless, keep a **reconcile poll** as the safety net: `GET /v2/orders` at 5 s
while any order is non-terminal, backing off to 30 s when nothing is working,
and stopping outside that user's session hours (`getSessionCloseIstMinutes()` —
which for an MCX-only book means running to 23:30, not 15:41).

### 7.2 Tier 2 — marks come from the existing feed, extended to options

Small change, high leverage. `resyncLiveFeedSubscriptions()`
(`apps/worker/src/worker.ts:152`) subscribes indices (`IDX_I`) and ~219 F&O
stocks (`NSE_EQ`). It never subscribes an **option contract**.

Add a third instrument set: the distinct `securityId`s across all open live
positions and working orders **across all users**, on their own segments
(`NSE_FNO` / `BSE_FNO` / `MCX_COMM`). `subscribe()` is additive and idempotent,
so this can be recomputed on every fill with no diffing.

**This set is the union across users, and it runs on the app account's feed —
not per user.** Market data is not account-specific, so subscribing the same
contract once serves every user holding it. Given Dhan's per-account WebSocket
instrument limits, the union is also the only approach that scales: ten users
each holding four condors is at most 40 distinct instruments, trivial beside the
219 stocks already subscribed, whereas ten per-user feeds would multiply both
sockets and instrument count for identical data.

Ticks land in the existing Redis cache (`cacheLiveTick`, merge-on-write, 45 s
staleness). **The live P&L path then never touches MySQL.**

That is not a micro-optimisation. The pool is the `mariadb` driver's
undocumented default of **10**, the boot prune grinds the box until ~09:15
(overlapping the 09:00 MCX open, §2.3), and `/api/market/overview` measured a
**4,132 ms median** during market hours on 2026-08-14. A live hot loop reading
`OptionContractTick` inherits all of it. Redis does not.

### 7.3 Tier 3 — one SSE channel per user, pushing deltas

Copy the `/api/market/stream` shape (`reply.hijack()`, client registry,
`retry: 5000`, 15 s heartbeat) into `/api/live/stream`, **scoped to the caller**:

```
event: order       { orderId, status, filledQty, avgFillPrice, at }
event: mark        { securityId, ltp, at }      // batched, ~1/s
event: position    { positionId, netQty, unrealizedPnl, at }
event: margin      { …LiveMarginView, at }      // ≤ every 5 s
event: alert       { rule, positionId, detail, at }
event: heartbeat   { serverTime }
```

**Send diffs, not the summary.** `/api/sim/summary` is a full rebuild every 30 s
today; at 1 Hz that would be pathological, and under multi-trader it multiplies
by connected users. `GET /api/live/summary` gives initial state on mount and on
reconnect; everything after is a delta.

**Batch `mark` events** — collect ticks for ~250–500 ms and emit one frame with
all changed securityIds. Twenty instruments ticking several times a second is
otherwise hundreds of frames a second carrying no extra information.

**Fan out per user, filter server-side.** A user's stream carries only the
securityIds they hold. Never broadcast the union and let the browser filter —
that leaks other users' positions to anyone reading the network tab.

### 7.4 Tier 4 — persistence decoupled from display

Write to MySQL only on **state transitions** (order status change, fill,
position open/close) plus a periodic MTM snapshot capped at one row per
5 minutes per position — the `SimMtmSnapshot` / `INTRADAY_MTM_SAMPLE_MS`
pattern, which exists precisely to stop a held position accumulating dozens of
rows a day. **Never a row per tick.**

### 7.5 What this does not need

- **A second browser poll loop.** A 30 s `setInterval` alongside the stream
  fights it and re-introduces the staleness. Poll only when the stream is down.
- **A wider `Promise.all`.** `LEG_TICK_FETCH_CONCURRENCY = 4` exists because a
  25-way fan-out in `getAtmCallIvHistory` took the API down. Stay under 10 —
  and note that under multi-trader a per-user fan-out multiplies by user count,
  which is a new way to hit the same wall.
- **Extra Dhan REST quote polling.** LTP and OHLC share **1 request/second
  combined** on the app account; `getFreshMarketAuxData` already sleeps 1.1 s
  between them. Use the WebSocket.

---

## 8. Recommendations and SL/target: same rules as Paper Trade Pro

Parity comes from sharing the code, not copying it.

### 8.1 Recommendations

`apps/web/src/components/sim-ticket-draft.ts` is already the single source of
truth for the regime → structure mapping, and its header comment says so.
**Reuse it unchanged.** The Live Order ticket pre-fills from the same
`SimTicketDraft`; add a `target: "sim" | "live"` field rather than a second key.
Add a "Trade Live" button beside "Paper Trade This", shown only to users who
have both the live tab and a verified credential.

**A recommendation never auto-places a live order.** Pre-filling a ticket is the
feature; the human presses the button. Auto-*exit* is defensible (§8.2);
auto-entry is not, at least not in phase 1.

### 8.2 SL and target

Paper Trade Pro's rules, verbatim from `sim-repository.ts`:

| Rule | Trigger | Paper action |
|---|---|---|
| `PROFIT_TARGET` | P&L ≥ 50% of credit (**30%** for `SHORT_STRADDLE`) | auto-close |
| `HARD_STOP_3X` | cost-to-close ≥ **3×** net credit | auto-close |
| `DTE_GAMMA` | ≤ **7** days to expiry (monthly horizon) | auto-close |
| `DELTA_2X_INTRADAY` | short leg's live delta ≥ 2× delta at fill | auto-close |
| `EXPIRY_ITM` | short leg ITM at expiry | settle |
| `DELIVERY_RISK` | stock option, short leg ITM inside expiry week | flag (margin ramps 1.5×) |

**`DTE_GAMMA` differs between paper and live, deliberately (2026-09-02).** Live
is **1 day** (`DTE_GAMMA_THRESHOLD_DAYS` in `packages/trading/src/exit-rules.ts`);
the table above is the simulator, which is still 7.

Seven was unusable live. NIFTY weeklies expire every Tuesday, so the near expiry
is never more than seven days out, and the engine closed every weekly position
on the first 20-second sweep after it opened — a 24100 CE sold at 51.80 was
bought back at 52.15 thirty seconds later, six days from expiry. The app also
only holds current and next week's chain, so a seven-day exclusion ruled out
most of what it can price.

**Do not "consolidate" the two numbers.** The simulator's 7 does double duty: a
monthly-horizon gamma exit *and* the expiry-week physical delivery ramp for
stock options, which starts at E-4. A one-day window would miss the ramp
entirely and silently disable delivery-risk handling.

**Extract these into `packages/trading/src/exit-rules.ts`** as pure functions
over `(legs, marks, credit, expiry, horizon, exchange) → ExitDecision | null`,
called by both `sim-repository.ts` and the live engine. Two copies of a stop
rule that are supposed to agree is exactly the drift this repo keeps single
definitions to avoid — same reasoning as `FALLBACK_LOT_SIZES` and
`shortLegMarginPerUnit` living in `packages/types`.

Four live-specific differences that must be explicit, not inherited:

1. **Evaluation cadence.** Sim uses a 5-minute timer. Live evaluates **on the
   tick stream** — a 3× stop checked every five minutes can be a 6× loss by the
   time it fires.
2. **`DELTA_2X_INTRADAY` will mostly not fire.** Dhan zeroes `delta` on **358 of
   462** NIFTY ticks on the 0-DTE expiry and 287 of 462 on the next (measured
   2026-08-11). A delta stop that silently never triggers is worse than no stop.
   Treat `0` as missing and **fall back to a price stop** (premium ≥ 2× entry)
   when a short leg has no usable delta, saying so in the UI.
3. **Exit orders need a price.** Sim closes at a modelled `mid ± χ·spread`. Live
   must place a real order: `STOP_LOSS_MARKET` for the hard stop (guaranteed to
   fire, accepts slippage), `LIMIT` for the profit target (no urgency, don't pay
   the spread). Never a plain `MARKET` on an illiquid strike — the liquidity gate
   should widen the limit or refuse, with **per-exchange thresholds** (§2.6e).
4. **`DELIVERY_RISK` is a hard exit on MCX, not a flag** (§2.6d). Devolvement
   into a futures position is a different order of consequence from a stock
   option's delivery obligation, and it must not depend on a user noticing a
   badge.

---

## 9. Safety rails

### 9.1 Access

- **Global env kill switch `LIVE_TRADING_ENABLED`, default false.** Routes 403,
  tab does not render. This is what makes it safe to merge the code before it is
  safe to use it.
- **Per-account switch** `LiveAccount.tradingEnabled`, default false. A user
  having a credential is not the same as being enabled to trade.
- **A verified credential is required** — `verifiedOk` true and
  `tokenExpiresAt` more than 2 h out, for entries.
- Tab gating via `UserTabAccess` (add `"live-order"` to `DashboardView`,
  `app-shell.tsx`, `app/page.tsx`, `admin-panel.tsx`). The tab gate is **UI**;
  every route checks the account switch itself.
- **No `/api/live/*` route takes a userId.** Under multi-trader this is the
  structural guarantee that no future role-checking bug can route one user's
  order into another user's brokerage account.

### 9.2 Caps, enforced server-side

`maxOrderMargin`, `maxOpenMargin`, `dailyLossLimit`, `maxMarginUtilPct`,
`maxOrdersPerMinute`, `allowUndefinedRisk` — all on `LiveAccount`, all checked
in the route, none editable from the UI. **In rupees of margin, not lots and not
notional** (§2.6b, §12.3). Breaching `dailyLossLimit` flips `tradingEnabled`
false and emails.

**The first gate is Dhan's own `insufficientBalance`**, returned on every margin
response. It is computed against real available funds including collateral and
blocked payouts, none of which we model. Refuse on non-zero before consulting
our own caps.

The **margin headroom floor** (`maxMarginUtilPct`, **50%**) matters more than
it looks: the exchange revalues margin six times a day and the calculator is
±20% at best. A position sized to 95% of available margin is one revaluation
from a margin call. 50% rather than 70% because, at ₹1,27,539.85, very few
positions fit at all — so any single position is a large fraction of the book
and there is no diversification to absorb a revaluation.

### 9.3 Idempotency and the unknown state

The worst failure in order placement is not a rejection — it is a **timeout**,
where you do not know whether the order exists. This repo already learned the
shape of that from RenewToken: *decide what a failure MEANS before reacting.*

- Generate `correlationId` **before** the call, persist `LOCAL_PENDING`, then
  call. The unique index means a retry cannot double-fire.
- On timeout or 5xx: do **not** retry blindly. Mark `UNKNOWN`, then
  `GET /v2/orders` and look for the `correlationId`. Found ⇒ adopt. Not found
  after two probes ⇒ safe to retry. Same probe-before-reacting logic as the 5xx
  branch of `dhan-token-renew.sh`.
- Every broker response, WS update, and reconcile result appends to
  `LiveOrderEvent`. **Append-only.** With money involved the audit trail matters
  more than the current-state row.

### 9.4 Reconciliation

A timer job and an on-demand route diffing local `LivePosition` / `LiveOrder`
against `GET /v2/positions` and `GET /v2/orders`, **per user**, treating Dhan as
authoritative in every disagreement. Drift is an email, not a log line.

Run it on every stream reconnect, every 30 s while that user's session is open,
and once at **each** session close — NSE 15:41 and MCX 23:30, via
`getSessionCloseIstMinutes()`. One NSE-shaped schedule applied to MCX is
precisely the bug that left two CRUDEOIL trades open with margin counted for an
extra day. The MCX pass runs at **23:35**, not bolted onto the existing 23:40
job, which has only ten minutes before shutdown (§2.6f).

### 9.5 Panic

`POST /api/live/panic` — cancel every working order, square off every position
at market, for the calling user only. One button, confirmed, available even when
`tradingEnabled` is false. It is the only thing you want when a token is about
to expire at 15:35 with two shorts open.

---

## 10. Suggested phasing

Each phase ships behind `LIVE_TRADING_ENABLED=false`.

| Phase | Scope | Ends when |
|---|---|---|
| **0** | Generalise `postDhan` to GET/PUT/DELETE keeping the audit choke point. Add place/modify/cancel, order book, positions, fundlimit. `productType` required. No UI | A 1-lot order places and cancels from a script on a real account |
| **1** | `UserBrokerCredential` + encryption + paste/validate UI + per-user `DhanClient` factory. Credential health in admin | A user can attach their own account and see their own funds |
| **2** | Schema, `/preview` + `/orders` + `/exit` + `/panic`, read-only panel, 30 s polling. Margin caps and kill switches live from day one. **NSE only, defined-risk only, one user** (§12.3, §12.4) | An NSE bull-put or bear-call spread round-trips end to end at 1 lot |
| **3** | **Latency**: option-contract subscriptions (union across users), Redis marks, `/api/live/stream` SSE deltas, order-update WS if it verifies | Marks < 1.5 s, order status ≤ 5 s, measured over a full session |
| **4** | Margin object (§6): hedge benefit, per-leg attribution, `includePosition`, headroom gating | Margin view matches a broker screenshot within ±20% on a real hedged basket |
| **5** | Shared `exit-rules.ts`, tick-driven evaluation, broker-side stops via Super Order | A stop fires correctly on a live 1-lot position |
| **6** | **MCX enablement**: `toBrokerQuantity()` lots-vs-contracts helper first, re-measured commodity margin on all four, per-exchange liquidity thresholds, `multiplier` handling, devolvement force-exit, 23:35 reconcile. **Blocked on funding** — one CRUDEOIL lot is 1.96× the account (§12.5) | A CRUDEOIL round trip works, and an ITM short is force-closed before devolvement |
| **7** | Per-user token renewal job (staggered), Sunday reminders, full reconciliation + alerting | A deliberate drift is detected and emailed; a weekend passes with no manual intervention on a maintenance weekend |

**Three orderings are deliberate.** Latency (3) precedes automated exits (5),
because a stop evaluated over 45-second-old marks is not a stop. MCX (6) comes
after the NSE path is proven, because it adds a lots-vs-contracts asymmetry that
mis-sizes orders 100×, a margin coefficient that was wrong by 1.6×, and a
devolvement tail — none of which should be debugged alongside the core order
path. And the whole thing runs **single-user until phase 7** (§12.4): the
multi-trader schema and code paths are in place from phase 1, but only one
account trades, because credential isolation is the one failure that cannot be
undone and cannot appear with one user.

**Two phases are gated on money, not code.** Phase 2 is defined-risk only and
phase 6 is blocked entirely, because at ₹1,27,539.85 no naked index or
commodity short is placeable. That is not a limitation to design around — it is
the reason phase 2 is safe to run at all.

---

## 11. Verification

The standing gate applies (`pnpm turbo run typecheck lint test`, plus
`pnpm --filter @option-decode/web build` for `apps/web`). On top:

- **Every rupee figure verified against the Dhan web terminal**, not against our
  model. Margin, available funds, position P&L, charges — for **both** an NSE
  and an MCX basket, since the commodity path shares no calibration with the
  index one.
- **A 1-lot live round trip** on the cheapest available contract before any
  multi-leg path is enabled, and again per exchange.
- **Margin cross-check logged**: `modelCrossCheck.divergencePct` on every view.
  Consistent divergence beyond ~30% on indices means one of the two is wrong and
  it is worth knowing which. On MCX the model is absent by design — if a
  commodity figure ever appears with `source: "MODEL"`, that is a bug.
- **Latency measured the documented way**: `api.log` joins the URL on
  `incoming request` to the duration on `request completed` by `reqId`. Measure
  over a **full session** — a two-minute sample has already produced a wrong
  conclusion in this repo once.
- **Credential isolation tested explicitly**: two users, two credentials, and a
  test asserting user A's order carries user A's `dhanClientId`. This is the one
  thing multi-trader can get catastrophically wrong, and it will not show up in
  any single-user test.
- `apps/web` has **no test script** — the panel is verified against live data,
  not unit tests. Do not claim test coverage for it.

---

## 12. The open questions, answered

### 12.1 Does Dhan's order-update WebSocket work for these accounts?

**Not verified, and deliberately not depended on.** The tooling available here
exposes Dhan's REST surface only, and the only way to confirm a push stream
delivers a fill is to place an order — which is out of scope for a design pass.

What *is* established: `GET /v2/orders` and `GET /v2/super/orders` both answer,
so **the polling fallback is proven available**. That settles the design
question even though it leaves the factual one open.

**Answer for planning: build the 5-second reconcile poll as the primary
mechanism, and treat the WebSocket as a later optimisation.** Rationale — the
poll is needed anyway as the safety net (§9.4), a push stream that is only
*mostly* reliable still needs it, and under multi-trader the WS is one socket
per user with its own reconnect and token-expiry lifecycle. Paying that
complexity for a latency gain on a signal that already lands in ≤ 5 s is the
wrong trade in phase 3.

The < 1 s order-status target in §7 is therefore **revised to ≤ 5 s**, which is
honest about what a poll delivers. Position *marks* keep the < 1.5 s target,
because those come from the tick feed and are unaffected.

Verification recipe when someone does test it: place a 1-lot limit order far
from the market, connect the socket, cancel the order, and check whether the
cancellation arrives as a push before the next poll would have caught it.

### 12.2 Do Super Orders accept F&O option legs with `productType: MARGIN`?

**Endpoint confirmed reachable; leg compatibility untested.** `super_list`
answers cleanly (the account holds none). Confirming that it *accepts* an
option leg requires placing one, which is a real trade.

**Answer for planning: design the stop engine so broker-side stops are an
enhancement, never a dependency.** Our own tick-driven rule engine (§8.2) is the
primary stop. If Super Orders turn out to accept option legs, they become a
second layer that survives our host being off — genuinely valuable given the
23:50–08:15 shutdown, but not something the module's correctness rests on.

Make this the explicit gate at the top of phase 5: place one Super Order on the
cheapest available option leg with `productType: MARGIN`, confirm it appears in
`super_list` with its `STOP_LOSS_LEG` intact, then cancel it. If it is rejected,
phase 5 ships with worker-side stops only and §2.3's overnight exposure stands
as a documented limitation rather than a solved problem.

Note one structural limit regardless of the answer: a four-leg condor is four
separate orders, so "the structure's 3×-credit stop" cannot be expressed as one
broker-side stop. Broker stops can only ever protect *legs*. Structure-level
rules stay ours.

### 12.3 What are the risk caps?

**Now answerable with real numbers, and the answer is restrictive.**

Available balance is **₹1,27,539.85**. Measured single-lot requirements:

| Position | Margin | vs balance |
|---|---|---|
| BANKNIFTY 1-lot short (56500 CE) | ₹2,22,712 | **1.75× the account** |
| BANKNIFTY 1-lot short (58000 CE) | ₹1,78,392 | **1.40×** |
| NIFTY 1-lot naked short (CLAUDE.md, verified in production) | ₹1,34,622 | **1.06×** |
| CRUDEOIL 1-lot short | ₹2,49,675 | **1.96×** |
| Any long/hedge leg | premium only (₹4,500 measured) | ~3.5% |

**The account cannot fund a single naked short on any index or commodity.** Not
one. That is the finding that should drive phase 2, and it is far more useful
than any cap number chosen in the abstract.

Recommended caps:

| Cap | Value | Reasoning |
|---|---|---|
| `maxOrderMargin` | **₹40,000** | ~31% of balance; permits defined-risk spreads, blocks every naked short measured above |
| `maxOpenMargin` (replaces `maxOpenNotional`) | **₹60,000** | ~47%. Notional is the wrong denominator — a spread's notional is huge and its risk is not |
| `dailyLossLimit` | **₹5,000** | ~4% of the account. Trips `tradingEnabled` false |
| `maxMarginUtilPct` | **50%** | Lowered from 70%. With so few positions fitting, one exchange revaluation is a large fraction of headroom |
| `maxOrdersPerMinute` | **6** | Unchanged; a human ticket rate |
| `lotCeilings` | `{}` — every symbol 1 lot | Nothing measured here justifies 2 |

**Two structural recommendations that matter more than the numbers:**

1. **Phase 2 ships defined-risk only.** Naked and undefined-risk structures
   (`SHORT_STRADDLE`, `SHORT_STRANGLE`, `NAKED_CALL`, `NAKED_PUT`) are blocked
   at the route, not merely capped. At this funding they cannot be placed
   anyway, so the block costs nothing and removes the largest blast radius from
   the riskiest phase.
2. **Use Dhan's own `insufficientBalance` field.** Every margin response carries
   it (₹50,852.15 on the BANKNIFTY probe, ₹1,22,135.15 on CRUDEOIL) — the
   broker computing the shortfall against real available funds. That is a
   better headroom gate than anything derived locally, because it accounts for
   collateral and blocked payouts we do not model. **Refuse any order whose
   preview returns a non-zero `insufficientBalance`**, before our own caps are
   even consulted.

### 12.4 How many concurrent live-trading users in phase 1?

**One.**

The constraint is not sockets or rate limits — it is that the funding supports
one small defined-risk book (§12.3), and that **credential isolation is the
highest-risk untested surface in the whole design**. A bug that routes user A's
order into user B's account is unrecoverable, and it cannot manifest with one
user.

Recommended progression:

- **Phases 2–5: exactly 1 live-trading user**, with the multi-trader *schema*
  and *code paths* fully in place. Building single-tenant and generalising later
  is how the isolation bug gets written.
- **Phase 7: expand to 3–5**, once the per-user renewal job and reconciliation
  are proven, and only after the two-user isolation test in §11 passes with two
  genuinely distinct credentials.

The resource math, for when it does expand: one WS socket per user for order
updates (if §12.1 is adopted), the market-data feed shared across all users, and
per-user Dhan rate budgets that do not contend. None of that binds below ~20
users. **Funding and isolation confidence bind long before infrastructure does.**

### 12.5 MCX devolvement mechanics and margin ramp

**Partially answered, and the practical answer is decisive: MCX is blocked on
funding, not on mechanics.**

One CRUDEOIL lot requires **₹2,49,675** — 1.96× the entire account. No MCX
position of any size is placeable at current funding, so phase 6 cannot be
tested regardless of what the devolvement rules turn out to be.

What was established: MCX margin runs ≈ **32% of notional** on an OTM strike
(§2.6a), and `quantity` is in lots (§2.6c). Both were previously unknown and
both would have caused real errors.

What remains genuinely unknown is the expiry behaviour — devolvement into a
futures position, and how far in advance the margin ramps. **Answer it by
observation, not by trading:** the four commodities are already captured in
`OptionChainSnapshot`, and CRUDEOIL expires monthly. Watch one full expiry in
observation mode — record the margin requirement on a hypothetical ITM short
across the final week via the calculator, and note where it steps. That gives
the ramp curve and the right force-exit lead time (§2.6d) with no capital at
risk and no order placed.

Until then, phase 6's force-exit default of **15:00 IST on expiry day** stands
as a conservative placeholder — early enough to beat any ramp observed so far,
and cheap to relax once the curve is known.

### 12.6 What is now open

Nothing blocking. Three things to verify during implementation rather than
before it:

1. Whether the corrected `multi` call returns real numbers against a live
   basket. Field names are settled and fixed; end-to-end behaviour is not yet
   confirmed. One preview call during market hours settles it.
2. Whether the order endpoints take `client-id` or `dhanClientId` (§3.3).
3. Whether SPAN/exposure are ever populated, or whether only `totalMargin` is
   real on this API.
