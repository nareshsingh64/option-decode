# Option Decode Dashboard Trading Guide

This guide explains how to read the Option Decode dashboard to estimate market trend, direction, pressure zones, and trade quality. It is designed for intraday decision support, not for blind trade execution. No dashboard can guarantee a safe or profitable trade; the objective is to avoid weak setups and take only trades where multiple signals agree.

## 1. Start With Market Context

Begin on the Dashboard view and read these fields first:

| Dashboard Signal | What It Means | How To Use It |
| --- | --- | --- |
| Market Bias | Overall pressure direction from bullish vs bearish pressure | First directional filter |
| Bullish Pressure | PE support dominance | Higher value means buyers/support are defending lower levels |
| Bearish Pressure | CE resistance dominance | Higher value means sellers/resistance are capping higher levels |
| OI Breadth | Whether total PE OI or CE OI is stronger | Confirms whether support or resistance is broader |
| Trade Readiness | Whether pressure edge is clear enough | Helps decide trade/no-trade |
| Active Alerts | Important pressure changes or risk warnings | Review before entering |

Basic interpretation:

- Bullish Pressure above Bearish Pressure means the market has upside support.
- Bearish Pressure above Bullish Pressure means the market has downside resistance.
- If both are close, the market is balanced and directional trades are lower quality.
- Trade Readiness should ideally be `Actionable` before taking a directional trade.

## 2. Read Support And Resistance First

Support and resistance define where the market may pause, reverse, or break.

Important dashboard fields:

- Nearest Support
- Nearest Resistance
- Support & Resistance Pressure
- Support & Resistance Zones
- Max OI Strike

How to read them:

- PE-heavy levels are support zones.
- CE-heavy levels are resistance zones.
- If spot is close to resistance and bearish pressure is strong, avoid chasing calls.
- If spot is close to support and bullish pressure is strong, avoid chasing puts.
- A clean breakout is stronger when price moves beyond a resistance/support level and pressure starts shifting in the breakout direction.

Practical rule:

- Buy CE only when price is above or breaking resistance with PE support building below.
- Buy PE only when price is below or breaking support with CE resistance building above.
- Avoid trades when spot is trapped between strong support and strong resistance with no clear pressure gap.

## 3. Use ATM +/-2 Strike Movement Score

This panel is one of the most important trend-reading tools. It focuses on ATM, ATM +1, ATM +2, ATM -1, and ATM -2 strikes.

Fields:

- Net Score
- Move Bias
- Score Trend
- PE Score
- CE Score

Interpretation:

- Positive Net Score means PE support is stronger than CE resistance at that strike.
- Negative Net Score means CE resistance is stronger than PE support at that strike.
- `Support increasing` means upside support is building.
- `Resistance increasing` means downside pressure is building.
- The strongest signal is near ATM and ATM +/-1 because those strikes react fastest during intraday moves.

Directional reading:

- Bullish setup: ATM and ATM +1 show positive score or improving PE support.
- Bearish setup: ATM and ATM -1 show negative score or improving CE resistance.
- Sideways setup: ATM scores are mixed, flat, or alternating.

## 4. Read The Option Chain Table

Open the Option Chain view for detailed confirmation.

Columns:

- CE OI: Call-side open interest, usually resistance.
- CE Chg: Change in call OI.
- CE LTP: Call price and price change.
- Strike: Strike price.
- PE LTP: Put price and price change.
- PE Chg: Change in put OI.
- PE OI: Put-side open interest, usually support.

The table marks highest and second-highest OI separately:

- `H1` means highest OI on that side.
- `H2` means second-highest OI on that side.
- CE `H1/H2` are major resistance strikes.
- PE `H1/H2` are major support strikes.

How to use H1/H2:

- If CE H1 is above spot, that level is strong resistance.
- If PE H1 is below spot, that level is strong support.
- If price breaks above CE H1 and CE OI starts reducing, bullish breakout quality improves.
- If price breaks below PE H1 and PE OI starts reducing, bearish breakdown quality improves.
- If both CE H1 and PE H1 are close to spot, the market may be range-bound.

## 5. Confirm With PCR And OI Breadth

PCR and OI breadth are confirmation tools, not entry triggers by themselves.

Reading:

- PCR above 1 generally means PE OI is stronger than CE OI.
- PCR below 1 generally means CE OI is stronger than PE OI.
- `Put Support` breadth supports bullish or buy-on-dip logic.
- `Call Resistance` breadth supports bearish or sell-on-rise logic.
- `Balanced` breadth means avoid aggressive directional trades unless price breaks a clear level.

Avoid using PCR alone. Always combine it with ATM score, support/resistance, and LTP behavior.

## 6. Use LTP And OI Together

OI without price movement can be misleading. Always compare OI change with option LTP change.

CE side:

- CE OI increasing + CE LTP falling: call writing, bearish/resistance.
- CE OI decreasing + CE LTP rising: short covering in calls, bullish.
- CE OI increasing + CE LTP rising: call buying or aggressive upside interest, watch for breakout.

PE side:

- PE OI increasing + PE LTP falling: put writing, bullish/support.
- PE OI decreasing + PE LTP rising: put short covering, bearish.
- PE OI increasing + PE LTP rising: put buying or downside hedge, watch for breakdown.

Best trades occur when OI and LTP tell the same story near ATM.

## 7. Direction Decision Checklist

Use this checklist before deciding direction.

Bullish direction is stronger when:

- Bullish Pressure is clearly higher than Bearish Pressure.
- OI Breadth says `Put Support`.
- ATM +/-2 score shows support building near ATM or ATM +1.
- Spot is above nearest support and moving toward resistance.
- PE H1/H2 are below spot and holding.
- CE resistance above spot is weakening or being broken.
- CE LTP is rising with positive momentum.

Bearish direction is stronger when:

- Bearish Pressure is clearly higher than Bullish Pressure.
- OI Breadth says `Call Resistance`.
- ATM +/-2 score shows resistance building near ATM or ATM -1.
- Spot is below nearest resistance and moving toward support.
- CE H1/H2 are above spot and holding.
- PE support below spot is weakening or being broken.
- PE LTP is rising with positive momentum.

No-trade condition:

- Bullish and bearish pressure are close.
- Trade Readiness is `Wait`.
- ATM scores are mixed.
- Spot is between strong CE H1 and PE H1.
- LTP change does not confirm OI change.
- Market is near expiry noise, news spike, or very low liquidity.

## 8. Choosing A Safer Trade

A safer trade is not the trade with the highest profit potential. It is the trade where risk is defined, direction is confirmed, and invalidation is nearby.

For CE trades:

1. Bias should be bullish or improving.
2. Spot should be holding above support.
3. ATM score should show support building.
4. Choose ATM or slightly ITM/near ATM CE for better liquidity.
5. Stop loss should be below the signal invalidation level.
6. Target should be before or near the next strong resistance.

For PE trades:

1. Bias should be bearish or worsening.
2. Spot should be rejecting resistance.
3. ATM score should show resistance building.
4. Choose ATM or slightly ITM/near ATM PE for better liquidity.
5. Stop loss should be above the signal invalidation level.
6. Target should be before or near the next strong support.

Avoid far OTM options unless the move is already confirmed and momentum is strong. Far OTM options can decay quickly and may not respond well unless there is a sharp move.

## 9. Risk/Reward And Position Size

In the Paper Trading module, always check:

- Entry LTP
- Stop Loss
- Target
- Risk / Reward
- Lots
- Lot Size
- Qty
- Target Payoff

Preferred risk rules:

- Minimum risk/reward should usually be 1:1.5.
- Better setups should offer 1:2 or higher.
- Do not increase lots to recover losses.
- Use fewer lots when signals are mixed or volatility is high.
- Avoid entering if stop loss is too wide compared with expected target.

Trade is poor quality when:

- Target is blocked by nearby resistance/support.
- Stop loss is far away.
- Option premium is too low and illiquid.
- Spread is wide.
- Dashboard pressure and LTP movement disagree.

## 10. Replay Before Trusting A Setup

Use Replay Lab to test how the same signal behaved earlier in the day.

Replay process:

1. Select expiry.
2. Select start time.
3. Load replay.
4. Watch snapshots across the full available period.
5. Check whether pressure signals appeared before the move or after the move.

Good signal:

- Pressure builds before price moves.
- ATM score changes before direction accelerates.
- H1/H2 support/resistance levels behave as expected.

Weak signal:

- Dashboard changes only after the move is complete.
- Signals flip frequently.
- Strong support/resistance breaks and immediately reverses.

## 11. Final Trade Decision Framework

Use this simple scoring before placing a paper trade:

| Check | Bullish Trade | Bearish Trade |
| --- | --- | --- |
| Pressure | Bullish > Bearish | Bearish > Bullish |
| Breadth | Put Support | Call Resistance |
| ATM Score | Positive/support building | Negative/resistance building |
| S/R | Above support | Below resistance |
| H1/H2 | PE support holds, CE weakens | CE resistance holds, PE weakens |
| LTP | CE price rising | PE price rising |
| Risk/Reward | At least 1:1.5 | At least 1:1.5 |

Trade quality:

- 6-7 checks aligned: high-quality paper trade candidate.
- 4-5 checks aligned: watch or small-size paper trade only.
- 3 or fewer checks aligned: no trade.

## 12. Practical Examples

Bullish example:

- Bullish Pressure 60%, Bearish Pressure 40%.
- OI Breadth shows Put Support.
- ATM +1 score is positive and support is increasing.
- PE H1 is below spot and stable.
- CE H1 above spot starts weakening.
- CE LTP rises.

Conclusion: CE trade can be considered, preferably ATM or near ATM, with target before the next resistance.

Bearish example:

- Bearish Pressure 62%, Bullish Pressure 38%.
- OI Breadth shows Call Resistance.
- ATM -1 score is negative and resistance is increasing.
- CE H1 above spot is strong.
- PE H1 below spot starts weakening.
- PE LTP rises.

Conclusion: PE trade can be considered, preferably ATM or near ATM, with target before the next support.

Range-bound example:

- Bullish Pressure 51%, Bearish Pressure 49%.
- OI Breadth is Balanced.
- ATM score is mixed.
- CE H1 and PE H1 are both close to spot.
- LTP movement is flat.

Conclusion: Avoid directional trades. Wait for breakout or breakdown confirmation.

## 13. Golden Rules

- Do not trade only because one metric looks strong.
- Direction needs agreement from pressure, ATM score, OI breadth, and LTP.
- Support and resistance decide entry quality.
- H1/H2 strikes are important barriers, not guaranteed reversal points.
- Paper trade first, especially after changing strategy rules.
- A safe trade is one where you know exactly why you entered, where you are wrong, and where you exit.
- Profitability comes from repeating clean setups, not from forcing trades every few minutes.

