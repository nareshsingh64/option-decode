# Option Decode Trading Interpretation Guide

This guide explains how to read the Option Decode dashboard, option chain, pressure engine, and paper trading module. It is written for intraday option analysis and paper-trade decision support.

Important: this document is not financial advice. No signal guarantees a safe or profitable trade. Use this guide to improve discipline, avoid weak setups, and define risk before entering a trade.

## 1. Reading Flow

Read the app in this order:

1. Check market context from the ticker and selected underlying.
2. Read Dashboard pressure and setup quality.
3. Confirm ATM +/-2 Strike Movement Score.
4. Open Option Chain and confirm OI, OI Change, Volume, LTP change, IV, and Delta.
5. Check support/resistance and max pain distance.
6. Choose trade type: option buying, option selling, or no trade.
7. Use Paper Trading to validate entry, stop loss, target, trail SL, and Delta exposure.

Do not start from a single strike. Start from the broader market pressure, then narrow down to the trade.

## 2. Top Ticker

The ticker shows index/commodity spot or active market price, previous close, absolute change, and percentage change.

How to read it:

| Signal | Meaning | Decision Use |
| --- | --- | --- |
| Price positive with % change positive | Underlying is trading above previous close | Supports bullish trades if option-chain pressure agrees |
| Price negative with % change negative | Underlying is trading below previous close | Supports bearish trades if option-chain pressure agrees |
| NSE/BSE closed but MCX open | Index values may show last feed, commodities should update live | Avoid comparing stale index data with live MCX data |
| Ticker flat but option pressure moving | Derivatives positioning may be changing before spot moves | Watch for breakout/breakdown confirmation |

Decision:

- Do not trade from ticker alone.
- Use ticker to understand current market state and whether the selected instrument is live or stale.

## 3. Market Controls

Market Controls choose the underlying and expiry. The dashboard, option chain, replay, and paper trading depend on this selection.

How to use:

- Select the exact symbol you want to analyze.
- Select the expiry you want to trade.
- For MCX, remember market hours differ from index options.
- If the symbol changes slowly, wait for the page to finish refreshing before interpreting signals.

Decision:

- Trade only the expiry shown in Market Controls.
- Do not compare dashboard signals from one expiry with paper trades from another expiry.

## 4. Dashboard Summary Cards

The four headline cards give the first read.

| Card | Meaning | Bullish Reading | Bearish Reading | Trade Decision |
| --- | --- | --- | --- | --- |
| Spot | Current underlying price and ATM strike | Spot holds above support | Spot rejects resistance | Use as reference for ATM and strike selection |
| Bullish Pressure | PE-side support pressure | Higher and rising | Weak or falling | Supports CE buying or PE selling |
| Bearish Pressure | CE-side resistance pressure | Weak or falling | Higher and rising | Supports PE buying or CE selling |
| PCR | Put/Call open-interest ratio | Usually stronger above 1.0 to 1.15 | Usually weaker below 1.0 to 0.85 | Confirmation only, not a standalone trigger |

Decision:

- Bullish Pressure > Bearish Pressure: look for bullish trades only if ATM score confirms.
- Bearish Pressure > Bullish Pressure: look for bearish trades only if ATM score confirms.
- Both close together: market is balanced; avoid forced directional trades.

## 5. Trading Command Center

The Trading Command Center is the main dashboard decision area.

### Market Bias

Shows the broad direction from pressure analysis.

- `Bullish`: PE support is stronger than CE resistance.
- `Bearish`: CE resistance is stronger than PE support.
- `Balanced`: no clear edge.

Decision:

- Bullish bias: prefer CE buying or PE selling.
- Bearish bias: prefer PE buying or CE selling.
- Balanced bias: wait or trade only very short range setups.

### OI Breadth

Shows whether total OI is broader on PE side, CE side, or balanced.

- `Put Support`: PE OI is stronger. Bullish support.
- `Call Resistance`: CE OI is stronger. Bearish resistance.
- `Balanced`: no strong OI side.

Decision:

- Bias and OI Breadth should agree.
- If bias says bullish but breadth says call resistance, reduce confidence.

### Setup Quality

Setup Quality combines pressure spread, PCR alignment, activity, and level proximity.

Typical reading:

- `A+ / A`: strong setup candidate.
- `B`: tradable only with confirmation.
- `C`: watch only.
- `Wait`: no clean edge.

Decision:

- For option buying, prefer `A` or `A+` because buyers need movement.
- For option selling, `B` can be acceptable if price is near a strong level and risk is controlled.
- Avoid fresh trades when setup quality says `Wait`.

### PCR

PCR in the command center explains whether put support or call resistance is dominant.

Decision:

- PCR above 1.15: put support is strong, but extreme PCR can also mean market is crowded.
- PCR below 0.85: call resistance is strong, but extreme weakness can reverse quickly.
- PCR near 1.0: neutral; wait for strike-level confirmation.

### Max Pain

Max Pain shows the strike where option writers would theoretically lose least if expiry settled there.

How to read:

- Spot above max pain: market is trading above the writer magnet.
- Spot below max pain: market is trading below the writer magnet.
- Spot close to max pain: market can become choppy.

Decision:

- Do not trade only because of max pain.
- If spot is near max pain and pressure is balanced, avoid aggressive buying.
- If spot moves away from max pain with strong pressure and ATM confirmation, directional trades improve.

### Conviction

Conviction measures whether pressure has enough activity behind it.

- `High`: signals have strong activity.
- `Medium`: trade only with confirmation.
- `Low`: avoid fresh directional trades.

Decision:

- High conviction + aligned bias + good setup quality = best trade zone.
- Low conviction = avoid chasing.

### Buyer Momentum

Buyer Momentum reads option buying/short-covering behavior around ATM strikes.

Decision:

- `CE buy` reading supports bullish option buying.
- `PE buy` reading supports bearish option buying.
- Neutral means option buyers are not strongly active.

### Seller Safety

Seller Safety reads whether option writing is safer on CE or PE side.

Decision:

- `Sell PE`: support-side writing appears safer.
- `Sell CE`: resistance-side writing appears safer.
- Neutral means option selling has no clear side.

## 6. Support And Resistance Zones

Support and resistance are built from OI and pressure.

| Zone | Meaning | Decision |
| --- | --- | --- |
| R1 | Nearest/strongest resistance | Avoid CE buying directly into it unless breakout confirms |
| R2 | Next resistance | Target zone for bullish trades |
| CMP | Current market price | Reference point |
| S1 | Nearest/strongest support | Avoid PE buying directly into it unless breakdown confirms |
| S2 | Next support | Target zone for bearish trades |

Decision:

- CE buying is better above support and before resistance.
- PE buying is better below resistance and before support.
- PE selling is better near support if support is holding.
- CE selling is better near resistance if resistance is holding.

## 7. ATM +/-2 Strike Movement Score

This panel is critical because it focuses on the strikes nearest to current price.

Fields:

| Field | Meaning |
| --- | --- |
| Strike | ATM, ATM +1, ATM +2, ATM -1, ATM -2 |
| Net Score | PE score minus CE score |
| Move Bias | Direction suggested by support/resistance around that strike |
| Score Trend | Whether support or resistance is increasing |
| PE / CE score | Raw strength on both option sides |

Interpretation:

- Positive Net Score: PE support stronger than CE resistance.
- Negative Net Score: CE resistance stronger than PE support.
- Increasing support: bullish pressure building.
- Increasing resistance: bearish pressure building.
- Flat: no fresh directional edge.

Decision:

- Bullish trade improves when ATM and ATM +1 show support building.
- Bearish trade improves when ATM and ATM -1 show resistance building.
- If ATM is mixed but far strikes are strong, wait. Far strikes are less reliable for immediate intraday entry.
- If score flips frequently, market is noisy. Use smaller size or avoid.

## 8. Option Chain Table

The option chain is the final confirmation layer.

### CE Side

| Column | Meaning | Interpretation |
| --- | --- | --- |
| CE IV / Delta | Volatility and directional sensitivity of call option | Higher Delta means option responds more to spot movement |
| CE OI | Call open interest | Usually resistance |
| CE Chg | Change in call OI | Rising can mean new call writing or call buying depending on LTP |
| CE Vol | Call trading volume | Confirms participation |
| CE LTP | Call last price and change from previous trading day reference | Rising call LTP supports bullish momentum |

### PE Side

| Column | Meaning | Interpretation |
| --- | --- | --- |
| PE LTP | Put last price and change | Rising put LTP supports bearish momentum |
| PE Vol | Put volume | Confirms participation |
| PE Chg | Change in put OI | Rising can mean put writing or put buying depending on LTP |
| PE OI | Put open interest | Usually support |
| PE IV / Delta | Volatility and directional sensitivity of put option | Put Delta is normally negative |

Decision:

- CE OI high above spot = resistance.
- PE OI high below spot = support.
- OI Change must be interpreted with LTP change.
- Volume confirms whether OI movement is meaningful.
- Delta helps choose a tradeable strike.

## 9. OI, OI Change, Volume Highlighting

The table highlights the strongest and second-strongest cells using full-color cells and percentage values.

How to read:

- Strong CE OI/Chg/Vol near or above spot: resistance pressure.
- Strong PE OI/Chg/Vol near or below spot: support pressure.
- Highest cell is more important than second-highest.
- Second-highest is highlighted only when strength is meaningful.

Decision:

- Do not buy CE directly below very strong CE resistance unless CE OI starts unwinding and CE LTP rises.
- Do not buy PE directly above very strong PE support unless PE OI starts unwinding and PE LTP rises.
- For sellers, sell near strong writing zones only when price respects that level.

## 10. LTP Change With OI Change

This is one of the most important interpretation rules.

### CE Interpretation

| CE OI Change | CE LTP Change | Meaning | Decision |
| --- | --- | --- | --- |
| Up | Down | Call writing | Bearish/resistance; CE selling may be safer |
| Up | Up | Call long buildup | Bullish breakout interest; CE buying possible |
| Down | Up | Call short covering | Bullish; resistance weakening |
| Down | Down | Call long unwinding | Bullish momentum weakening |

### PE Interpretation

| PE OI Change | PE LTP Change | Meaning | Decision |
| --- | --- | --- | --- |
| Up | Down | Put writing | Bullish/support; PE selling may be safer |
| Up | Up | Put long buildup | Bearish breakdown interest; PE buying possible |
| Down | Up | Put short covering | Bearish; support weakening |
| Down | Down | Put long unwinding | Bearish momentum weakening |

Decision:

- Option buyers need LTP rising in the selected option.
- Option sellers prefer writing signals with price respecting support/resistance.

## 11. IV And Delta

### IV

IV shows option premium richness.

Decision:

- Rising IV helps option buyers if direction is correct.
- Falling IV hurts option buyers even if spot moves slowly.
- High IV near event/news increases risk for sellers.

### Delta

Delta shows how much option price should move for a 1-point move in the underlying, approximately.

Typical use:

- ATM options: higher responsiveness, usually better for intraday.
- Far OTM options: lower Delta, cheaper but less responsive.
- ITM options: higher Delta, more expensive but more stable.

Decision:

- For buying, prefer liquid ATM or slightly ITM/near ATM options.
- Avoid very low Delta options unless expecting a sharp move.
- For selling, monitor total Net Delta in Paper Trading to avoid hidden directional exposure.

## 12. OI Buildup Chart

The OI buildup chart gives a visual map:

- CE OI usually extends left.
- PE OI usually extends right.
- Bright bars mean OI building.
- Dim bars mean shedding/unwinding.
- ATM row is the most important reference.

Decision:

- PE bars building below ATM support bullish trades.
- CE bars building above ATM support bearish trades.
- OI shedding at a resistance/support level means that level is weakening.

## 13. IV Skew Chart

IV skew shows implied volatility across strikes.

Interpretation:

- Higher PE IV can show downside fear or hedging demand.
- Higher CE IV can show upside speculation.
- A steep skew means premium is uneven across strikes.

Decision:

- Option buyers should avoid overpaying where IV is already very high unless momentum is strong.
- Option sellers should be careful selling high-IV options without level confirmation and stop loss.

## 14. Option Buying Playbook

### Buy CE Setup

Prefer CE buying when:

- Market Bias is bullish.
- Setup Quality is A or A+.
- OI Breadth says Put Support.
- ATM and ATM +1 show support building.
- CE LTP is rising.
- CE OI is not strongly blocking the next resistance, or CE OI is unwinding.
- Spot is above support and has room to next resistance.

Avoid CE buying when:

- Spot is directly below strong CE OI resistance.
- CE LTP is flat or falling.
- IV is very high and spot momentum is weak.
- Setup Quality says Wait.

### Buy PE Setup

Prefer PE buying when:

- Market Bias is bearish.
- Setup Quality is A or A+.
- OI Breadth says Call Resistance.
- ATM and ATM -1 show resistance building.
- PE LTP is rising.
- PE support below spot is weakening or breaking.
- Spot is below resistance and has room to next support.

Avoid PE buying when:

- Spot is directly above strong PE OI support.
- PE LTP is flat or falling.
- IV is very high and spot momentum is weak.
- Setup Quality says Wait.

## 15. Option Selling Playbook

Option selling requires stricter risk control because loss can expand quickly.

### Sell PE Setup

Prefer PE selling when:

- Market Bias is bullish or balanced with strong support.
- Seller Safety says Sell PE.
- Strong PE OI/PE writing exists below spot.
- Spot respects support.
- PE LTP is falling while PE OI is rising.
- Target is limited and stop loss is defined.

Avoid PE selling when:

- PE LTP is rising with PE OI rising.
- Support is breaking.
- IV is low and premium is not worth the risk.

### Sell CE Setup

Prefer CE selling when:

- Market Bias is bearish or balanced with strong resistance.
- Seller Safety says Sell CE.
- Strong CE OI/CE writing exists above spot.
- Spot rejects resistance.
- CE LTP is falling while CE OI is rising.
- Target is limited and stop loss is defined.

Avoid CE selling when:

- CE LTP is rising with CE OI rising.
- Resistance is breaking.
- IV is low and premium is not worth the risk.

## 16. Paper Trading Module

Use Paper Trading before trusting a setup.

### Order Ticket

Fields:

- Symbol/expiry: confirms what you are trading.
- Order: BUY or SELL.
- Type: CE or PE.
- Strike: selected strike.
- LTP: live option price.
- Entry: trigger price.
- SL: stop loss.
- Target: expected exit.
- Contracts/Qty: lot-based exposure.
- Risk/Reward: whether trade is worth taking.

Decision:

- BUY order should wait for LTP <= entry.
- SELL order should wait for LTP >= entry.
- Do not enter if risk/reward is poor.

### Pending Orders

Pending orders show orders waiting for trigger.

Decision:

- Modify entry if price has moved away.
- Cancel stale orders if dashboard bias changes.
- Do not leave old pending orders after market structure changes.

### Open Positions

Open positions show:

- Entry price.
- Current LTP.
- Delta.
- Net Delta.
- Trail SL.
- Target.
- P/L.

Decision:

- If Delta exposure is too high in one direction, reduce lots or avoid adding same-side trades.
- If ATM score turns against the position, tighten trail SL.
- If price reaches target area before dashboard confirms continuation, book profit.

### Open Position Totals

Grouped by underlying and expiry.

Decision:

- Net positive Delta means portfolio benefits from upward movement.
- Net negative Delta means portfolio benefits from downward movement.
- Large absolute Net Delta means high directional risk.

## 17. Replay Lab

Replay validates whether signals worked earlier in the day.

Use replay to answer:

- Did pressure build before the move?
- Did ATM +/-2 score lead or lag?
- Did strong OI levels behave like support/resistance?
- Did LTP and OI agree?

Decision:

- If replay shows signals are late or flipping often, reduce confidence.
- If replay shows signals leading price, the setup has better quality.

## 18. Trade Decision Checklist

Use this checklist before any trade.

| Check | Bullish Trade | Bearish Trade |
| --- | --- | --- |
| Market Bias | Bullish | Bearish |
| Setup Quality | A / A+ preferred | A / A+ preferred |
| OI Breadth | Put Support | Call Resistance |
| ATM Score | Support building | Resistance building |
| LTP | CE LTP rising | PE LTP rising |
| S/R | Above support with room to resistance | Below resistance with room to support |
| Option Chain | CE resistance weakening or PE writing strong | PE support weakening or CE writing strong |
| IV/Delta | Responsive strike, not overpriced | Responsive strike, not overpriced |
| Risk/Reward | At least 1:1.5 | At least 1:1.5 |

Trade quality:

- 8-9 checks aligned: high-quality paper trade candidate.
- 6-7 checks aligned: tradable with controlled size.
- 4-5 checks aligned: watch only or very small paper trade.
- 3 or fewer checks aligned: no trade.

## 19. No-Trade Conditions

Avoid trades when:

- Setup Quality says Wait.
- Bullish and bearish pressure are close.
- ATM score is mixed or flipping rapidly.
- Spot is trapped between strong CE and PE walls.
- LTP does not confirm OI movement.
- Option volume is low.
- Spread is wide.
- IV is high but price is not moving.
- Market is reacting to sudden news.
- Your stop loss is too far from entry.

No trade is a valid trading decision.

## 20. Practical Examples

### Bullish CE Buy

Signals:

- Bullish Pressure 62%, Bearish Pressure 38%.
- OI Breadth says Put Support.
- Setup Quality A.
- ATM and ATM +1 show Increasing Support.
- CE LTP rising.
- PE OI strong below spot.
- Next CE resistance is still far enough.

Decision:

- Consider ATM or near-ATM CE buy.
- Stop loss below the failed support/option invalidation.
- Target before next resistance.

### Bearish PE Buy

Signals:

- Bearish Pressure 64%, Bullish Pressure 36%.
- OI Breadth says Call Resistance.
- Setup Quality A.
- ATM and ATM -1 show Increasing Resistance.
- PE LTP rising.
- PE support below spot is weakening.

Decision:

- Consider ATM or near-ATM PE buy.
- Stop loss above resistance rejection.
- Target before next support.

### PE Sell

Signals:

- Bias bullish or balanced.
- Seller Safety says Sell PE.
- PE writing below spot.
- PE LTP falling.
- Spot repeatedly holds support.

Decision:

- Consider PE sell only with defined SL.
- Exit if support breaks or PE LTP starts rising with OI.

### CE Sell

Signals:

- Bias bearish or balanced.
- Seller Safety says Sell CE.
- CE writing above spot.
- CE LTP falling.
- Spot repeatedly rejects resistance.

Decision:

- Consider CE sell only with defined SL.
- Exit if resistance breaks or CE LTP starts rising with OI.

### Range-Bound Market

Signals:

- Pressure close to 50/50.
- PCR near 1.
- ATM scores mixed.
- Strong CE resistance above and PE support below.

Decision:

- Avoid directional buying.
- Wait for breakout/breakdown.
- Only experienced sellers may consider range trades with strict SL.

## 21. Golden Rules

- Never trade from one signal.
- Pressure gives direction, option chain gives confirmation, paper trading defines risk.
- ATM and ATM +/-1 matter most for intraday entries.
- OI without LTP can mislead.
- LTP without volume can mislead.
- IV can make a correct direction unprofitable if premium is overpriced.
- Delta tells how much directional exposure you are carrying.
- Strong support/resistance is a decision point, not a guarantee.
- If signals disagree, wait.
- The safest trade is the one where you know entry, invalidation, target, and reason before placing the order.
