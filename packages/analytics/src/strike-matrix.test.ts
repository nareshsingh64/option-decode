import { test } from "node:test";
import assert from "node:assert/strict";
import type { OptionChainSnapshot, OptionContractTick } from "@option-decode/types";
import { calculateStrikeMatrix, isTradingHorizon, STRIKE_MATRIX_HORIZONS } from "./strike-matrix.js";

function tick(overrides: Partial<OptionContractTick> & Pick<OptionContractTick, "optionType" | "strikePrice">): OptionContractTick {
  return {
    tradingDate: "2026-07-16",
    tickTime: "2026-07-16T10:00:00.000Z",
    underlyingSymbol: "NIFTY",
    expiry: "2026-07-21",
    lastPrice: 100,
    ...overrides
  };
}

function snapshot(ticks: OptionContractTick[]): OptionChainSnapshot {
  return {
    tradingDate: "2026-07-16",
    snapshotTime: "2026-07-16T10:00:00.000Z",
    underlyingSymbol: "NIFTY",
    expiry: "2026-07-21",
    spotPrice: 25000,
    atmStrike: 25000,
    ticks
  };
}

test("universe keeps only strikes inside the horizon delta band and with a delta", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 100, changeInOpenInterest: 50 }),
      tick({ optionType: "CE", strikePrice: 25000, delta: 0.5, volume: 100, changeInOpenInterest: 50 }), // outside band
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 100, changeInOpenInterest: 50 }),
      tick({ optionType: "PE", strikePrice: 24000, delta: -0.05, volume: 100, changeInOpenInterest: 50 }), // outside band
      tick({ optionType: "PE", strikePrice: 24900, volume: 100, changeInOpenInterest: 50 }) // no delta
    ]),
    "intraday"
  );
  assert.deepEqual(
    result.universe.map((row) => row.strikePrice).sort((a, b) => a - b),
    [24800, 25200]
  );
});

test("WCI is oiChange / volume and undefined at zero volume", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 400, changeInOpenInterest: 100 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 0, changeInOpenInterest: 100 })
    ]),
    "intraday"
  );
  const call = result.universe.find((row) => row.optionType === "CE");
  const put = result.universe.find((row) => row.optionType === "PE");
  assert.equal(call?.wci, 0.25);
  assert.equal(put?.wci, undefined);
});

test("DRC is signed and DRCR aggregates |DRC| puts over |DRC| calls", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      // put DRC = 1000 × -0.2 = -200 → |200|
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: 1000 }),
      // call DRC = 500 × 0.2 = 100
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500 })
    ]),
    "intraday"
  );
  const put = result.universe.find((row) => row.optionType === "PE");
  assert.equal(put?.drc, -200);
  assert.equal(result.putDrcTotal, 200);
  assert.equal(result.callDrcTotal, 100);
  assert.equal(result.drcr, 2);
  assert.equal(result.bias, "Bullish");
});

test("DRCR bias bands: neutral, bearish, transitional gap, and zero-call guard", () => {
  const build = (putOic: number, callOic: number) =>
    calculateStrikeMatrix(
      snapshot([
        tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: putOic }),
        tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: callOic })
      ]),
      "intraday"
    );
  assert.equal(build(1000, 1000).bias, "Neutral"); // DRCR 1.0
  assert.equal(build(500, 1000).bias, "Bearish"); // DRCR 0.5
  assert.equal(build(1300, 1000).bias, "Transitional"); // DRCR 1.3 gap

  // Puts written with no call-side writing at all: no finite ratio exists,
  // but the direction is unambiguous. This used to read "Transitional"
  // while its mirror (zero PUT churn) read a confident "Bearish".
  const zeroCall = build(1000, 0);
  assert.equal(zeroCall.drcr, undefined);
  assert.equal(zeroCall.bias, "Bullish");
  // Still no recommendation - the fixture's PE strike carries no open
  // interest, so it can't clear the execution-strike liquidity floor.
  assert.equal(zeroCall.recommendation, undefined);
});

test("DRCR excludes unwinding OI - a strike closing positions doesn't count as writer conviction being built", () => {
  // Reproduces the live shape (BANKNIFTY monthly): a put strike's OI is
  // net NEGATIVE (positions closing/covering) while a call strike's OI is
  // opening. The old Σ|DRC| formula counted the put's magnitude anyway
  // and read "Bullish"; it must now read as if that side had no
  // qualifying activity at all.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: -2880 }), // closing, not building
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500 })
    ]),
    "intraday"
  );
  assert.equal(result.putDrcTotal, 0, "a closing put strike should contribute nothing to putDrcTotal");
  assert.equal(result.bias, "Bearish", "calls being written while puts are covered is unambiguously bearish");
  assert.equal(result.drcr, undefined, "there is no finite ratio when the put side has no opening flow - the direction is reported, not a fabricated 0");
});

test("a near-zero-activity strike can't be called an institutional wall, however perfect its WCI ratio", () => {
  // Reproduces the live shape on illiquid commodity chains (COPPER,
  // SILVER): two contracts trade and both open, so WCI = 2/2 = 1.0 - the
  // maximum possible ratio - off two contracts. It must never outrank or
  // masquerade as institutional backing.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 2, changeInOpenInterest: 2, openInterest: 4 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  const callWall = result.callWall!;
  assert.equal(callWall.wci, 1, "the raw ratio is still 1.0 and is still reported honestly");
  assert.equal(callWall.meetsThreshold, false, "but two contracts is not institutional backing");
});

test("a genuinely heavy wall is preferred over a perfect-ratio but near-empty strike on the same side", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      // Out-of-band background so the chain's own turnover baseline (and
      // therefore the relative WCI threshold) isn't set by the two strikes
      // under test themselves.
      tick({ optionType: "CE", strikePrice: 26000, delta: 0.5, volume: 100000, changeInOpenInterest: 5000, openInterest: 50000 }),
      // Perfect WCI (1.0) on 3 contracts.
      tick({ optionType: "CE", strikePrice: 25100, delta: 0.2, volume: 3, changeInOpenInterest: 3, openInterest: 6 }),
      // Lower WCI (0.75) but real size behind it.
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.18, volume: 4000, changeInOpenInterest: 3000, openInterest: 9000 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25200, "size-backed conviction should win the wall slot over a degenerate ratio");
  assert.equal(result.callWall?.meetsThreshold, true);
});

test("one-sided writer flow reads symmetrically - calls-only is Bearish, puts-only is Bullish", () => {
  // The zero-guard used to be asymmetric: zero call churn returned
  // undefined ("Transitional") while zero put churn produced drcr = 0 and
  // a confident "Bearish". Both are equally one-sided and equally
  // informative, so both must now yield a definite bias.
  const callsOnly = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: -500 }), // closing
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500 }) // opening
    ]),
    "intraday"
  );
  const putsOnly = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: 500 }), // opening
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: -500 }) // closing
    ]),
    "intraday"
  );

  assert.equal(callsOnly.bias, "Bearish");
  assert.equal(putsOnly.bias, "Bullish", "the mirror case used to fall through to Transitional, silently discarding a real signal");
  assert.equal(callsOnly.drcr, undefined);
  assert.equal(putsOnly.drcr, undefined);
});

test("no opening flow on either side is the only genuine no-signal case", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: -500 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: -500 })
    ]),
    "intraday"
  );
  assert.equal(result.drcr, undefined);
  assert.equal(result.bias, "Transitional");
  assert.equal(result.recommendation, undefined);
});

test("DRCR is normalized per qualifying strike, not a raw sum, so put skew alone can't rule out Bearish", () => {
  // Reproduces the live shape (NIFTY): more PE strikes structurally
  // qualify in-band than CE strikes, independent of any real flow
  // difference. Three PE strikes with modest opening OI vs one CE strike
  // with much larger opening OI - the raw sum would still read Bullish
  // (3 x 200 = 600 puts vs 1 x 100 calls), but per-strike, the call side
  // is clearly the stronger signal (100 avg vs 66.7 avg).
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.16, volume: 1000, changeInOpenInterest: 200 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 200 }),
      tick({ optionType: "PE", strikePrice: 24900, delta: -0.2, volume: 1000, changeInOpenInterest: 200 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500 })
    ]),
    "intraday"
  );
  // put avg |DRC| = (200*0.16 + 200*0.18 + 200*0.2) / 3 = (32+36+40)/3 = 36
  // call avg |DRC| = 500*0.2 / 1 = 100
  // drcr = 36/100 = 0.36 -> Bearish, not Bullish as the raw-sum version would read
  assert.equal(result.drcr, 0.36);
  assert.equal(result.bias, "Bearish");
});

test("walls pick highest |WCI| per side and apply the horizon threshold to signed WCI", () => {
  // Chain-wide baseline = (400+100+300)/3000 = 0.2667; intraday threshold =
  // 0.2667 × 1.3 ≈ 0.347. Only the 0.4 WCI strike clears it.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 400 }), // WCI 0.4
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.16, volume: 1000, changeInOpenInterest: 100 }), // WCI 0.1
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: -300 }) // WCI -0.30 (unwinding)
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25200);
  assert.equal(result.callWall?.meetsThreshold, true);
  assert.equal(result.putWall?.strikePrice, 24800); // highest |WCI|
  assert.equal(result.putWall?.meetsThreshold, false); // negative WCI never qualifies
});

test("a qualifying wall is never masked by a larger-magnitude unwinding strike on the same side", () => {
  // Reproduces the exact live shape (BANKNIFTY, 2026-07-31): a strongly
  // negative (unwinding) strike has bigger |WCI| than a genuinely
  // qualifying strike elsewhere on the same side. The qualifying one must
  // win - previously the unwinding strike won on magnitude alone and the
  // real wall was never surfaced anywhere in the response. A high-volume
  // background strike (outside the intraday delta band, so excluded from
  // the universe) keeps the chain-wide baseline realistic: baseline =
  // (1000+800+2000)/53000 ≈ 0.0717, threshold ≈ 0.0717 × 1.3 ≈ 0.093.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25100, delta: 0.2, volume: 1000, changeInOpenInterest: -1000 }), // WCI -1.0, unwinding, larger |WCI|
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.18, volume: 2000, changeInOpenInterest: 800 }), // WCI 0.4, qualifies
      tick({ optionType: "CE", strikePrice: 26500, delta: 0.5, volume: 50000, changeInOpenInterest: 2000 }) // background, outside band
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25200);
  assert.equal(result.callWall?.meetsThreshold, true);
});

test("with no qualifying strike on a side, the highest-|WCI| strike still surfaces for display", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25100, delta: 0.2, volume: 1000, changeInOpenInterest: -300 }), // WCI -0.30
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.18, volume: 1000, changeInOpenInterest: 50 }) // WCI 0.05, doesn't qualify either
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25100); // highest |WCI| among non-qualifiers
  assert.equal(result.callWall?.meetsThreshold, false);
});

test("weekly horizon applies a stricter WCI multiplier than intraday against the same chain", () => {
  // Both horizons derive their threshold from the same chain-wide
  // baseline (150/1000 = 0.15) but weekly demands a bigger multiple above
  // it (1.75x vs intraday's 1.3x) - reflecting the doc's higher
  // conviction bar for overnight/weekend gap risk.
  const chain = snapshot([tick({ optionType: "CE", strikePrice: 25200, delta: 0.15, volume: 1000, changeInOpenInterest: 150 })]);
  const intradayResult = calculateStrikeMatrix(chain, "intraday");
  const weeklyResult = calculateStrikeMatrix(chain, "weekly");
  assert.equal(intradayResult.wciThreshold, 0.15 * 1.3);
  assert.equal(weeklyResult.wciThreshold, 0.15 * 1.75);
  assert.ok(weeklyResult.wciThreshold > intradayResult.wciThreshold);
});

test("the WCI threshold scales with a chain's own aggregate turnover, not one fixed absolute number", () => {
  // Reproduces the live front-week vs back-week regime gap (NIFTY,
  // production, 2026-07-31): a front-week contract's day-volume runs far
  // ahead of its OI change, structurally pinning every strike's WCI lower
  // than a back-week contract's at the same instant - confirmed live,
  // front-week's chain-wide ratio ran 0.03-0.13 through the day vs
  // back-week's tight 0.11-0.14 at the same moments. The threshold must
  // track that regime rather than judging both against one fixed bar.
  const highTurnoverChain = snapshot([
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 100000, changeInOpenInterest: 5000 }) // WCI 0.05
  ]);
  const lowTurnoverChain = snapshot([
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 10000, changeInOpenInterest: 5000 }) // WCI 0.5
  ]);
  const highTurnoverResult = calculateStrikeMatrix(highTurnoverChain, "intraday");
  const lowTurnoverResult = calculateStrikeMatrix(lowTurnoverChain, "intraday");
  assert.ok(highTurnoverResult.wciThreshold < lowTurnoverResult.wciThreshold);
});

test("recommendation picks execution strikes closest to the matrix cell's target delta", () => {
  // Neutral intraday → short strangle at ±0.15
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.22, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.16, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.24, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.15, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Neutral"); // DRCR = (120+75)/(110+80) ≈ 1.03
  assert.equal(result.recommendation?.structure, "Sell short strangle");
  assert.equal(result.recommendation?.callStrike, 25300);
  assert.equal(result.recommendation?.putStrike, 24700);
  // Both legs must expire worthless, so the two tails subtract:
  // 1 - |0.16| - |0.15| = 0.69. Used to read a flat 85 regardless.
  assert.equal(result.recommendation?.theoreticalPop, 69);
});

test("a zero-liquidity strike closest to target delta is skipped in favor of a liquid one further away", () => {
  // Reproduces the exact live shape (BANKNIFTY): the strike nearest target
  // delta has zero OI and zero volume - it must never be recommended, even
  // though it's the mathematically closest match.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25150, delta: 0.18, volume: 0, changeInOpenInterest: 0, openInterest: 0 }), // exact target delta, illiquid
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.22, volume: 1000, changeInOpenInterest: 200, openInterest: 5000 }), // further from target, liquid, still inside the delta band
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.18, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Bullish");
  assert.equal(result.recommendation?.putStrike, 24700);
});

test("a Neutral (both-sides) structure withholds the whole recommendation when one required side has no liquid strike", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.15, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.15, volume: 0, changeInOpenInterest: 500, openInterest: 0 }) // only CE strike in the universe, illiquid
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Neutral"); // Neutral intraday writes both sides
  assert.equal(result.recommendation, undefined, "no execution strike exists for the call side, so the recommendation must not fire at all rather than naming an illiquid strike");
});

test("bullish structures only populate the put side", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Bullish"); // DRCR = 360/100 = 3.6
  assert.equal(result.recommendation?.callStrike, undefined);
  assert.equal(result.recommendation?.putStrike, 24800);
});

test("theoreticalPop tracks the strikes actually picked - one tail for a single leg, both for a strangle", () => {
  // Bullish intraday writes PUTS only, so only the put tail subtracts.
  const singleLeg = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(singleLeg.bias, "Bullish");
  assert.equal(singleLeg.recommendation?.callStrike, undefined, "a bullish structure writes no call leg");
  assert.equal(singleLeg.recommendation?.theoreticalPop, 82); // 1 - |−0.18|

  // Neutral writes both sides, so both tails subtract off the same base.
  const twoLeg = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.16, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.15, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(twoLeg.bias, "Neutral");
  assert.equal(twoLeg.recommendation?.theoreticalPop, 69); // 1 - 0.16 - 0.15
  assert.ok(
    twoLeg.recommendation!.theoreticalPop < singleLeg.recommendation!.theoreticalPop,
    "a two-legged structure has two ways to lose, so its POP must be strictly lower than a comparable single leg"
  );
});

test("a recommendation written against no qualifying wall is flagged as unbacked", () => {
  // Reproduces the live shape (NIFTY default view, 100% of sampled
  // recommendations): a tradable DRCR bias with a valid execution strike,
  // but WCI never clears the conviction bar on the written side - so the
  // structure is DRCR-only, with no institutional wall behind the strike.
  // The out-of-band background strike carries a high OI-change-to-volume
  // ratio, lifting the chain's own turnover baseline (and therefore the
  // relative threshold) well above what either in-band strike manages.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25000, delta: 0.5, volume: 10000, changeInOpenInterest: 5000, openInterest: 20000 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 100000, changeInOpenInterest: 2000, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 100000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Bullish");
  assert.ok(result.recommendation, "expected a recommendation to still fire - the bias itself is tradable");
  assert.equal(result.putWall?.meetsThreshold, false);
  assert.equal(result.recommendation!.wallBacked, false);
  assert.deepEqual(result.recommendation!.unbackedSides, ["PE"]);
});

test("a recommendation whose written side has a qualifying wall reads as backed", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      // High OI change against modest volume -> WCI clears the bar.
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Bullish");
  assert.equal(result.putWall?.meetsThreshold, true);
  assert.equal(result.recommendation!.wallBacked, true);
  assert.deepEqual(result.recommendation!.unbackedSides, []);
});

test("only the side a structure actually writes counts toward wall backing", () => {
  // Bullish intraday writes PUTS only, so an unqualifying CALL wall must
  // not mark the recommendation unbacked - the call side isn't being sold.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 500000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Bullish");
  assert.equal(result.callWall?.meetsThreshold, false, "the call wall genuinely does not qualify");
  assert.equal(result.recommendation!.wallBacked, true, "but this structure only writes puts, so call backing is irrelevant");
  assert.deepEqual(result.recommendation!.unbackedSides, []);
});

test("a horizon applied to a contract of the wrong tenor is flagged, not applied silently", () => {
  const chain = snapshot([
    tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000, openInterest: 5000 }),
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
  ]);
  // Default fixture expiry is 2026-07-21; analysed as of 2026-07-16, so
  // ~5 days out - a genuinely weekly-tenor contract.
  const asOf = new Date("2026-07-16T04:00:00.000Z");

  const weekly = calculateStrikeMatrix(chain, "weekly", asOf);
  assert.equal(weekly.horizonTenorMismatch, undefined, "weekly against a ~5-DTE chain is the matching pairing");

  // Reproduces BANKNIFTY's live case in miniature: the intraday framework
  // pointed at a chain that is nowhere near expiry.
  const intraday = calculateStrikeMatrix(chain, "intraday", asOf);
  assert.ok(intraday.horizonTenorMismatch, "intraday against a ~5-DTE chain should be flagged");
  assert.match(intraday.horizonTenorMismatch!, /shorter-dated/);

  // Reproduces NIFTY's live case: monthly framework, weekly-only chain.
  const monthly = calculateStrikeMatrix(chain, "monthly", asOf);
  assert.ok(monthly.horizonTenorMismatch, "monthly against a ~5-DTE chain should be flagged");
  assert.match(monthly.horizonTenorMismatch!, /longer-dated/);
});

test("daysToExpiry is reported alongside the analysis so the tenor is never implicit", () => {
  const chain = snapshot([tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000, openInterest: 5000 })]);
  const result = calculateStrikeMatrix(chain, "weekly", new Date("2026-07-16T10:00:00.000Z"));
  assert.equal(Math.round(result.daysToExpiry), 5); // 2026-07-16 -> 2026-07-21
});

test("isTradingHorizon narrows only the three valid horizons", () => {
  assert.equal(isTradingHorizon("intraday"), true);
  assert.equal(isTradingHorizon("weekly"), true);
  assert.equal(isTradingHorizon("monthly"), true);
  assert.equal(isTradingHorizon("daily"), false);
  assert.equal(isTradingHorizon(undefined), false);
});

test("horizon profiles match the decision-matrix doc", () => {
  assert.equal(STRIKE_MATRIX_HORIZONS.intraday.deltaMin, 0.15);
  assert.equal(STRIKE_MATRIX_HORIZONS.intraday.deltaMax, 0.25);
  assert.equal(STRIKE_MATRIX_HORIZONS.weekly.deltaMin, 0.12);
  assert.equal(STRIKE_MATRIX_HORIZONS.weekly.deltaMax, 0.2);
  assert.equal(STRIKE_MATRIX_HORIZONS.monthly.deltaMin, 0.08);
  assert.equal(STRIKE_MATRIX_HORIZONS.monthly.deltaMax, 0.15);
});

test("intraday's 2x-delta rule reports unevaluated (pre-trade), not silently passing", () => {
  const result = calculateStrikeMatrix(snapshot([tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 100 })]), "intraday");
  assert.equal(result.riskRuleStatus.satisfied, undefined);
  assert.match(result.riskRuleStatus.detail, /Sim auto-closes/);
});

test("weekly's weekend-decay window reads satisfied on a Friday afternoon and unsatisfied mid-week", () => {
  const snap = snapshot([tick({ optionType: "CE", strikePrice: 25200, delta: 0.15, volume: 1000, changeInOpenInterest: 100 })]);
  // 2026-07-31 is a Friday; 14:00 IST = 08:30 UTC.
  const fridayAfternoon = calculateStrikeMatrix(snap, "weekly", new Date("2026-07-31T08:30:00.000Z"));
  assert.equal(fridayAfternoon.riskRuleStatus.satisfied, true);

  // 2026-07-29 is a Wednesday; 11:00 IST = 05:30 UTC.
  const wednesday = calculateStrikeMatrix(snap, "weekly", new Date("2026-07-29T05:30:00.000Z"));
  assert.equal(wednesday.riskRuleStatus.satisfied, false);
});

test("monthly's IV Rank gate reports unevaluated without enough history, then computes a real rank once there is enough", () => {
  const snap = snapshot([tick({ optionType: "CE", strikePrice: 25000, delta: 0.1, volume: 1000, changeInOpenInterest: 100, impliedVolatility: 18 })]);

  const noHistory = calculateStrikeMatrix(snap, "monthly", new Date(), []);
  assert.equal(noHistory.riskRuleStatus.satisfied, undefined);
  assert.match(noHistory.riskRuleStatus.detail, /Not enough IV history/);

  // 20 days of history, all below today's 18 -> IV Rank 100%, clears the 30% floor.
  const history = new Array(20).fill(10);
  const withHistory = calculateStrikeMatrix(snap, "monthly", new Date(), history);
  assert.equal(withHistory.riskRuleStatus.satisfied, true);
  assert.match(withHistory.riskRuleStatus.detail, /IV Rank 100%/);

  // Today's IV (18) sits below all 20 history days (all 25) -> IV Rank 0%, fails the floor.
  const highHistory = new Array(20).fill(25);
  const belowFloor = calculateStrikeMatrix(snap, "monthly", new Date(), highHistory);
  assert.equal(belowFloor.riskRuleStatus.satisfied, false);
  assert.match(belowFloor.riskRuleStatus.detail, /IV Rank 0%/);
});

test("Institutional Unwinding fires on a call short-covering signature in the ATM/near-OTM band, outside any horizon's own universe", () => {
  // Reproduces the live shape (BANKNIFTY): a call at |delta| 0.5 (well
  // outside every horizon's <=0.25 cap) shows OI falling while price
  // rises - writers covering their short calls.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25000, delta: 0.5, volume: 1000, changeInOpenInterest: -300, lastPriceChange: 5 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 100 }) // inside the intraday universe, irrelevant here
    ]),
    "intraday"
  );
  assert.ok(result.universe.every((row) => row.strikePrice !== 25000), "the covering strike sits outside intraday's own delta band");
  assert.deepEqual(result.institutionalUnwinding, { strikePrice: 25000, delta: 0.5, oiChange: -300 });
});

test("Institutional Unwinding does not fire on long-unwinding (OI and price both falling)", () => {
  const result = calculateStrikeMatrix(
    snapshot([tick({ optionType: "CE", strikePrice: 25000, delta: 0.5, volume: 1000, changeInOpenInterest: -300, lastPriceChange: -5 })]),
    "intraday"
  );
  assert.equal(result.institutionalUnwinding, undefined);
});
