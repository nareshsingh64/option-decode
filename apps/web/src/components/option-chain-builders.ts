import { MIN_RECOMMENDATION_OPEN_INTEREST, OI_BREADTH_DOMINANCE_RATIO, pressureValue } from "@option-decode/analytics";
import { NSE_SESSION_CLOSE_IST_MINUTES } from "@option-decode/types";
import type { OptionContractTick } from "@option-decode/types";
import type { MarketOverview, OverviewTick } from "./live-dashboard";
import { classifyOptionActivity, type OptionActivityKind } from "./strike-pressure-analytics";

export type { OptionActivityKind };
export type NumberFormatMode = "indian" | "metric";
export type QuantityDisplayMode = "lots" | "numbers";

// Used only as a stand-in for the expected-move calculation when the real
// India VIX quote is unavailable. Callers must check vixAvailable before
// trusting/displaying `vix` - this default exists purely so the strike
// range still renders something, not because 15% is a real reading.
const DEFAULT_VIX_FALLBACK = 15;

export interface VixStrikeRange {
  lower: number;
  upper: number;
  expectedMove: number;
  vix: number;
  vixAvailable: boolean;
  // "atm": centered on the live ATM strike (what the caller asked for).
  // "vix": derived from the VIX expected-move formula instead - either
  // because the caller asked for VIX mode directly, or because ATM mode
  // was requested but the current ATM strike couldn't be located in the
  // chain, and this is a silent-fallback path callers should surface.
  rangeMode: "atm" | "vix";
}

export interface DisplayPreferences {
  numberFormatMode: NumberFormatMode;
  quantityDisplayMode: QuantityDisplayMode;
}

export function buildVixStrikeRange(overview: MarketOverview): VixStrikeRange {
  const spot = overview.snapshot.spotPrice;
  const vixAvailable = Boolean(overview.indiaVix && overview.indiaVix > 0);
  const vix = vixAvailable ? (overview.indiaVix as number) : DEFAULT_VIX_FALLBACK;
  const daysToExpiry = getDaysToExpiry(overview.snapshot.expiry, overview.snapshot.snapshotTime);
  const expectedMove = spot > 0 ? spot * (vix / 100) * Math.sqrt(daysToExpiry / 365) : 0;

  return {
    lower: Math.max(0, spot - expectedMove),
    upper: spot + expectedMove,
    expectedMove,
    vix,
    vixAvailable,
    rangeMode: "vix"
  };
}

export function buildAtmStrikeRange(overview: MarketOverview): VixStrikeRange {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === overview.snapshot.atmStrike);
  if (atmIndex < 0) {
    // ATM strike isn't in the current chain (stale/mismatched snapshot) -
    // fall back to the VIX-derived range. rangeMode stays "vix" so callers
    // that asked for "atm" can detect the fallback happened and say so.
    return buildVixStrikeRange(overview);
  }
  const visibleStrikes = strikes.slice(Math.max(0, atmIndex - 6), atmIndex + 7);
  return {
    lower: visibleStrikes[0] ?? overview.snapshot.atmStrike,
    upper: visibleStrikes[visibleStrikes.length - 1] ?? overview.snapshot.atmStrike,
    expectedMove: Math.abs((visibleStrikes[visibleStrikes.length - 1] ?? overview.snapshot.atmStrike) - overview.snapshot.atmStrike),
    vix: overview.indiaVix && overview.indiaVix > 0 ? overview.indiaVix : DEFAULT_VIX_FALLBACK,
    vixAvailable: Boolean(overview.indiaVix && overview.indiaVix > 0),
    rangeMode: "atm"
  };
}

function getDaysToExpiry(expiry: string, snapshotTime: string) {
  // Market close, from the shared constants rather than retyped - NSE moved
  // to 15:41 IST, and this used to hardcode 15:30 independently.
  const closeIst = `${String(Math.floor(NSE_SESSION_CLOSE_IST_MINUTES / 60)).padStart(2, "0")}:${String(NSE_SESSION_CLOSE_IST_MINUTES % 60).padStart(2, "0")}`;
  const expiryTime = Date.parse(`${expiry}T${closeIst}:00+05:30`);
  const snapshotDate = Date.parse(snapshotTime);
  if (!Number.isFinite(expiryTime) || !Number.isFinite(snapshotDate)) {
    return 1;
  }
  return Math.max(1, Math.ceil((expiryTime - snapshotDate) / 86_400_000));
}

// Intrinsic value is what the option is worth on moneyness alone if it
// expired right now: a call is worth spot - strike once spot is above it, a
// put is worth strike - spot once spot is below. Everything above that in
// the premium is TIME value - the part that decays, and the part a seller
// is actually harvesting. Both were absent from the whole codebase (the
// only prior occurrence of the concept was a local variable inside
// calculateMaxPain, never surfaced), so the chain showed what an option
// costs without showing how much of that is moneyness you carry versus
// decay you collect.
function intrinsicValue(optionType: "CE" | "PE", strike: number, spot: number): number {
  return optionType === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

// Time value needs a live premium to subtract from, and only means
// anything when that premium is at least the option's intrinsic value.
//
// A stale or crossed quote can print an LTP *below* intrinsic. Flooring
// the result at 0 there would render an internally inconsistent pair - a
// deep-ITM put showing "133 intr / 0 tv" beside an LTP of 120, which does
// not add up on screen and invites the reader to distrust both numbers.
// Returning undefined instead means the UI simply omits the split for that
// strike rather than showing a reconciliation that fails. The small
// tolerance absorbs ordinary rounding at the feed's 2-decimal precision
// without letting a genuinely crossed quote through.
const CROSSED_QUOTE_TOLERANCE = 0.05;

function timeValue(lastPrice: number | undefined, intrinsic: number): number | undefined {
  if (lastPrice === undefined || lastPrice + CROSSED_QUOTE_TOLERANCE < intrinsic) {
    return undefined;
  }
  return Math.max(0, lastPrice - intrinsic);
}

// How many of the heaviest open-interest strikes per side are pulled back
// into view when the expected-move window would have excluded them.
// Two per side matches what the chain marks (strongest and second
// strongest support and resistance), so the marking can never point at a
// level that isn't on screen.
const ALWAYS_VISIBLE_OI_WALLS_PER_SIDE = 2;

// The heaviest-OI strikes on each side, regardless of where the range
// falls. Ranked on raw open interest rather than the display-converted
// value: which strike carries the most OI is a property of the chain, not
// of whether the user is currently viewing lots or contracts.
function topOpenInterestStrikes(ticks: OverviewTick[], optionType: "CE" | "PE"): number[] {
  return ticks
    .filter((tick) => tick.optionType === optionType && (tick.openInterest ?? 0) > 0)
    .sort((left, right) => (right.openInterest ?? 0) - (left.openInterest ?? 0))
    .slice(0, ALWAYS_VISIBLE_OI_WALLS_PER_SIDE)
    .map((tick) => tick.strikePrice);
}

export function buildChainRows(overview: MarketOverview, range: VixStrikeRange, preferences: DisplayPreferences) {
  const spot = overview.snapshot.spotPrice;
  const ticksByStrike = new Map<number, Partial<Record<"CE" | "PE", OverviewTick>>>();

  for (const tick of overview.snapshot.ticks) {
    const row = ticksByStrike.get(tick.strikePrice) ?? {};
    row[tick.optionType] = tick;
    ticksByStrike.set(tick.strikePrice, row);
  }

  // The expected-move window alone regularly excludes the heaviest OI
  // strikes - confirmed live, NIFTY's window [23859, 24874] left out BOTH
  // the top call wall (25000) and the top put wall (23000), and CRUDEOIL
  // and SILVER did the same. That matters beyond the missing rows: the
  // support/resistance marking below can only rank what survives this
  // filter, so it was choosing a "strongest support" from a set that
  // excluded the actual strongest support.
  //
  // The window still decides the bulk of the view (the whole point of the
  // range is to avoid rendering every strike), but the top OI walls are
  // unioned back in and flagged outOfRange so the table can show they sit
  // beyond the expected move rather than pretending they're inside it.
  const wallStrikes = new Set([
    ...topOpenInterestStrikes(overview.snapshot.ticks, "CE"),
    ...topOpenInterestStrikes(overview.snapshot.ticks, "PE")
  ]);

  const isInRange = (strike: number) => strike >= range.lower && strike <= range.upper;

  const allRows = [...ticksByStrike.entries()]
    .filter(([strike]) => isInRange(strike) || wallStrikes.has(strike))
    .map(([strike, pair]) => ({
      strike,
      // True only for strikes pulled in as OI walls from beyond the
      // expected-move window - the table renders these differently so the
      // range stays a meaningful boundary rather than a silent fiction.
      outOfRange: !isInRange(strike),
      ceIntrinsic: intrinsicValue("CE", strike, spot),
      ceTimeValue: timeValue(pair.CE?.lastPrice, intrinsicValue("CE", strike, spot)),
      peIntrinsic: intrinsicValue("PE", strike, spot),
      peTimeValue: timeValue(pair.PE?.lastPrice, intrinsicValue("PE", strike, spot)),
      ceOi: formatQuantityValue(pair.CE?.openInterest, pair.CE, preferences),
      ceOiLots: toLots(pair.CE?.openInterest, pair.CE),
      ceOiRaw: pair.CE?.openInterest ?? 0,
      ceChg: formatQuantityValue(pair.CE?.changeInOpenInterest, pair.CE, preferences, true),
      ceChgSignedLots: toLots(pair.CE?.changeInOpenInterest, pair.CE),
      ceChgLots: Math.abs(toLots(pair.CE?.changeInOpenInterest, pair.CE)),
      ceChgRaw: Math.abs(pair.CE?.changeInOpenInterest ?? 0),
      ceVol: formatQuantityValue(pair.CE?.volume, pair.CE, preferences),
      ceVolLots: toLots(pair.CE?.volume, pair.CE),
      ceVolRaw: pair.CE?.volume ?? 0,
      ceLtp: pair.CE?.lastPrice,
      ceLtpChange: pair.CE?.lastPriceChange,
      ceLtpChangePercent: pair.CE?.lastPriceChangePercent,
      ceActivity: classifyOptionActivity(pair.CE),
      ceIv: pair.CE?.impliedVolatility,
      ceDelta: pair.CE?.delta,
      ceGamma: pair.CE?.gamma,
      ceTheta: pair.CE?.theta,
      ceVega: pair.CE?.vega,
      peLtp: pair.PE?.lastPrice,
      peLtpChange: pair.PE?.lastPriceChange,
      peLtpChangePercent: pair.PE?.lastPriceChangePercent,
      peActivity: classifyOptionActivity(pair.PE),
      peIv: pair.PE?.impliedVolatility,
      peDelta: pair.PE?.delta,
      peGamma: pair.PE?.gamma,
      peTheta: pair.PE?.theta,
      peVega: pair.PE?.vega,
      peVol: formatQuantityValue(pair.PE?.volume, pair.PE, preferences),
      peVolLots: toLots(pair.PE?.volume, pair.PE),
      peVolRaw: pair.PE?.volume ?? 0,
      peChg: formatQuantityValue(pair.PE?.changeInOpenInterest, pair.PE, preferences, true),
      peChgSignedLots: toLots(pair.PE?.changeInOpenInterest, pair.PE),
      peChgLots: Math.abs(toLots(pair.PE?.changeInOpenInterest, pair.PE)),
      peChgRaw: Math.abs(pair.PE?.changeInOpenInterest ?? 0),
      peOi: formatQuantityValue(pair.PE?.openInterest, pair.PE, preferences),
      peOiLots: toLots(pair.PE?.openInterest, pair.PE),
      peOiRaw: pair.PE?.openInterest ?? 0,
      ceOiPercent: 0,
      ceChgPercent: 0,
      ceVolPercent: 0,
      peOiPercent: 0,
      peChgPercent: 0,
      peVolPercent: 0,
      // ONE verdict per side, from the three guards combined - not six
      // independent leaderboards. ceSrRank identifies the strongest (1) and
      // second strongest (2) RESISTANCE, peSrRank the same for SUPPORT.
      ceSrRank: undefined as 1 | 2 | undefined,
      peSrRank: undefined as 1 | 2 | undefined,
      ceSrScore: 0,
      peSrScore: 0
    }))
    .sort((left, right) => right.strike - left.strike);

  const visibleRows = allRows;

  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceOiLots, row.ceOiRaw, preferences), (row, percent) => {
    row.ceOiPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceChgLots, row.ceChgRaw, preferences), (row, percent) => {
    row.ceChgPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceVolLots, row.ceVolRaw, preferences), (row, percent) => {
    row.ceVolPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peOiLots, row.peOiRaw, preferences), (row, percent) => {
    row.peOiPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peChgLots, row.peChgRaw, preferences), (row, percent) => {
    row.peChgPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peVolLots, row.peVolRaw, preferences), (row, percent) => {
    row.peVolPercent = percent;
  });

  // The three guards, combined into ONE score per strike per side, then
  // ranked once. This replaces six independent leaderboards (OI, OI change
  // and volume, per side) that between them flagged three to four different
  // strikes as "strongest" with no verdict - confirmed live on NIFTY, where
  // resistance was simultaneously 24800 by OI, 24400 by OI change and
  // volume, and 24500 by volume rank 2.
  //
  // pressureValue is the Dashboard's own zone-scoring function, reused
  // rather than reimplemented: open interest as the base, OI change
  // weighted by activity quadrant (writing counts most, and unwinding
  // SUBTRACTS rather than counting as strength), and a volume contribution
  // capped at the strike's own OI so turnover confirms a level instead of
  // defining it. That last cap is why a chain whose volume runs 15-16x its
  // OI no longer reads as a most-traded-strike list.
  const ceAverageVolume = averageVolumeOf(visibleRows.map((row) => row.ceVolLots));
  const peAverageVolume = averageVolumeOf(visibleRows.map((row) => row.peVolLots));
  for (const row of visibleRows) {
    row.ceSrScore = pressureValue(toScoringTick(row, "CE"), ceAverageVolume);
    row.peSrScore = pressureValue(toScoringTick(row, "PE"), peAverageVolume);
  }

  // Ranked directionally, matching topZones in @option-decode/analytics:
  // resistance is a ceiling so it can only be at or above the money, support
  // is a floor so it can only be at or below. Without this the combined score
  // happily returned a "2nd strongest support" ABOVE spot - live NIFTY gave
  // 24500 against a spot of 24367, and SENSEX did the same - which is a put
  // wall the market has already traded through, not a floor under it.
  //
  // The pivot is the ATM strike rather than raw spot: spot almost never sits
  // exactly on a strike, so testing against it hands the ATM strike to
  // whichever side happens to be nearer. With NIFTY spot 24590.85 and ATM
  // 24600 the ATM put wall - routinely the heaviest support on the chain -
  // was excluded from support ranking every single tick.
  const moneyPivot = overview.snapshot.atmStrike || spot;
  applyPressureRanks(visibleRows, (row) => (row.strike >= moneyPivot ? row.ceSrScore : 0), (row, rank) => {
    row.ceSrRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => (row.strike <= moneyPivot ? row.peSrScore : 0), (row, rank) => {
    row.peSrRank = rank;
  });

  return visibleRows;
}

function averageVolumeOf(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

// Rebuilds the minimal OptionContractTick shape pressureValue reads. The
// row already holds these in LOTS (toLots was applied when the row was
// built), so lotSize is pinned to 1 here to stop pressureValue dividing a
// second time. Signed OI change is deliberate - pressureValue's own
// quadrant logic needs the sign to tell writing from unwinding, and the
// row's ceChgLots/peChgLots are absolute values.
function toScoringTick(
  row: { strike: number; ceOiLots: number; ceChgSignedLots: number; ceVolLots: number; ceLtpChange?: number; peOiLots: number; peChgSignedLots: number; peVolLots: number; peLtpChange?: number },
  optionType: "CE" | "PE"
): OptionContractTick {
  const isCall = optionType === "CE";
  return {
    tradingDate: "",
    tickTime: "",
    underlyingSymbol: "",
    expiry: "",
    optionType,
    strikePrice: row.strike,
    lotSize: 1,
    openInterest: isCall ? row.ceOiLots : row.peOiLots,
    changeInOpenInterest: isCall ? row.ceChgSignedLots : row.peChgSignedLots,
    volume: isCall ? row.ceVolLots : row.peVolLots,
    lastPriceChange: (isCall ? row.ceLtpChange : row.peLtpChange) ?? 0
  };
}

export function buildOiBuildupRows(chainRows: ReturnType<typeof buildChainRows>, atmStrike: number, numberFormatMode: NumberFormatMode) {
  const maxOi = Math.max(0, ...chainRows.flatMap((row) => [row.ceOiLots, row.peOiLots]));
  const oiPercent = (value: number) => (maxOi > 0 && value > 0 ? Math.max(3, Math.round((value / maxOi) * 100)) : 0);
  return chainRows.map((row) => ({
    strike: row.strike,
    isAtm: row.strike === atmStrike,
    cePercent: oiPercent(row.ceOiLots),
    pePercent: oiPercent(row.peOiLots),
    ceBuilding: row.ceChgSignedLots >= 0,
    peBuilding: row.peChgSignedLots >= 0,
    ceLabel: formatLarge(row.ceOiLots, numberFormatMode),
    peLabel: formatLarge(row.peOiLots, numberFormatMode)
  }));
}

export type ChainMode = "buy" | "sell";

// --- Market read strip -------------------------------------------------
// Six cells answering "what kind of market is this, and which side" before
// the trader reads a single strike. Every metric serves BOTH directions -
// only the verdict flips - which is why one mode toggle covers buying and
// selling rather than needing two separate layouts.

export interface MarketReadCell {
  label: string;
  value: string;
  detail: string;
  verdict: string;
  tone: "good" | "warn" | "info" | "neutral";
}

export function buildMarketRead(
  overview: MarketOverview,
  range: VixStrikeRange,
  chainStats: ReturnType<typeof buildChainStats>,
  mode: ChainMode,
  numberFormatMode: NumberFormatMode
): MarketReadCell[] {
  const spot = overview.snapshot.spotPrice;
  const atm = overview.snapshot.atmStrike;
  const atmCe = overview.snapshot.ticks.find((tick) => tick.optionType === "CE" && tick.strikePrice === atm);
  const atmPe = overview.snapshot.ticks.find((tick) => tick.optionType === "PE" && tick.strikePrice === atm);

  // --- IV percentile ---
  const iv = overview.atmIvPercentile;
  const ivCell: MarketReadCell = !iv
    ? { label: "ATM IV", value: "--", detail: "no history yet", verdict: "UNAVAILABLE", tone: "neutral" }
    : !iv.sufficient
      ? {
          label: "ATM IV",
          value: `${iv.current.toFixed(2)}%`,
          detail: `only ${iv.sampleDays} day${iv.sampleDays === 1 ? "" : "s"} of history`,
          verdict: "TOO LITTLE HISTORY",
          tone: "neutral"
        }
      : {
          label: "IV percentile",
          value: `${iv.percentile}`,
          detail: `ATM ${iv.current.toFixed(2)}% · ${iv.sampleDays}d ${iv.low.toFixed(1)}-${iv.high.toFixed(1)}%`,
          // High IV favours the seller and penalises the buyer; low IV the
          // reverse. Same number, opposite reading.
          verdict:
            iv.percentile >= 70
              ? mode === "sell" ? "RICH — GOOD TO SELL" : "EXPENSIVE — POOR TO BUY"
              : iv.percentile <= 30
                ? mode === "sell" ? "CHEAP — POOR TO SELL" : "CHEAP — GOOD TO BUY"
                : "MIDDLING — NO VOL EDGE",
          tone:
            iv.percentile >= 70
              ? mode === "sell" ? "good" : "warn"
              : iv.percentile <= 30
                ? mode === "sell" ? "warn" : "good"
                : "info"
        };

  // --- Skew (PE IV - CE IV at the money) ---
  const ceIv = atmCe?.impliedVolatility;
  const peIv = atmPe?.impliedVolatility;
  const skew = ceIv !== undefined && peIv !== undefined && ceIv > 0 && peIv > 0 ? peIv - ceIv : undefined;
  const skewCell: MarketReadCell =
    skew === undefined
      ? { label: "Skew", value: "--", detail: "no ATM IV on one side", verdict: "UNAVAILABLE", tone: "neutral" }
      : {
          label: "Skew",
          value: `${skew >= 0 ? "+" : ""}${skew.toFixed(2)}`,
          detail: `PE ${peIv!.toFixed(2)} vs CE ${ceIv!.toFixed(2)}`,
          // A seller wants the richer side; a buyer wants the cheaper one -
          // so the same sign points them at opposite legs.
          verdict:
            Math.abs(skew) < 0.5
              ? "FLAT — NO SIDE EDGE"
              : skew > 0
                ? mode === "sell" ? "SELL PUTS — RICHER" : "BUY CALLS — CHEAPER"
                : mode === "sell" ? "SELL CALLS — RICHER" : "BUY PUTS — CHEAPER",
          tone: Math.abs(skew) < 0.5 ? "info" : "good"
        };

  // --- PCR / OI breadth ---
  const pcr = overview.pressure.pcr;
  const pcrCell: MarketReadCell = {
    label: "PCR",
    value: pcr === undefined ? "--" : pcr.toFixed(2),
    detail: chainStats.breadth,
    verdict: pcr === undefined ? "UNAVAILABLE" : pcr > 1.1 ? "PUT SUPPORT DOMINANT" : pcr < 0.9 ? "CALL RESISTANCE DOMINANT" : "BALANCED",
    tone: "info"
  };

  // --- Expected move ---
  const straddle = overview.atmStraddle?.atmStraddlePrice;
  const movePercent = spot > 0 ? (range.expectedMove / spot) * 100 : 0;
  const moveCell: MarketReadCell = {
    label: "Expected move",
    value: `±${Math.round(range.expectedMove)}`,
    detail: straddle ? `${movePercent.toFixed(2)}% of spot · ATM straddle ${straddle.toFixed(0)}` : `${movePercent.toFixed(2)}% of spot`,
    // The seller's cushion is the buyer's hurdle.
    verdict: mode === "sell" ? "ROOM BEFORE BREACH" : "MOVE NEEDED TO PROFIT",
    tone: mode === "sell" ? "info" : "warn"
  };

  // --- Kept: total OI and max-OI strike ---
  const oiCell: MarketReadCell = {
    label: "Total OI",
    value: `CE ${formatLarge(chainStats.totalCeOi, numberFormatMode)}`,
    detail: `PE ${formatLarge(chainStats.totalPeOi, numberFormatMode)}`,
    verdict: "CHAIN-WIDE",
    tone: "neutral"
  };
  const maxOiCell: MarketReadCell = {
    label: "Max OI strike",
    value: chainStats.maxOiStrikeText,
    detail: chainStats.maxOiSide,
    verdict: "HEAVIEST SINGLE STRIKE",
    tone: "neutral"
  };

  return [ivCell, skewCell, pcrCell, moveCell, oiCell, maxOiCell];
}

// --- Premium ladder ----------------------------------------------------
// What the trader would actually transact at each horizon, rather than what
// every strike happens to cost. Sell mode uses the Strike Matrix's own delta
// bands and reports credit + probability of profit; buy mode reports cost,
// breakeven and the move required to reach it.

export interface LadderLeg {
  optionType: "CE" | "PE";
  strike: number;
  price: number;
  delta: number;
  // Sell mode only - probability the short leg expires worthless.
  pop?: number;
  // Buy mode only - spot at which the long leg breaks even, and the move
  // from here needed to get there.
  breakeven?: number;
  movePercent?: number;
}

export interface LadderBand {
  label: string;
  detail: string;
  legs: LadderLeg[];
  // Sell mode only - combined credit for writing both legs.
  credit?: number;
  // Shown in place of legs when nothing qualifies, so an empty band explains
  // itself rather than looking broken.
  emptyNote?: string;
}

// Sell-side bands mirror STRIKE_MATRIX_HORIZONS' target deltas exactly, so
// the ladder can never suggest a strike the Strike Matrix tab wouldn't.
const SELL_LADDER_BANDS: Array<{ label: string; targetDelta: number }> = [
  { label: "Intraday", targetDelta: 0.18 },
  { label: "Weekly", targetDelta: 0.15 },
  { label: "Monthly", targetDelta: 0.1 }
];

// Buying is a delta FLOOR rather than a set of bands: the trader wants a
// contract that tracks the underlying, and anything at or above this is
// acceptable. Deliberately not three fixed targets like the sell side -
// Dhan sends delta/IV/theta as literal 0 for ITM calls (47 strikes on a
// normal day, including ones carrying 24 lakh OI), so a 0.70/0.80/0.90
// ladder would silently repeat the one call strike that does carry greeks
// in all three rows. Listing whatever clears the floor degrades honestly.
const MIN_BUY_DELTA = 0.7;
const BUY_CANDIDATES_PER_SIDE = 3;

// A strike with a printed price but no book behind it is not a fill. Reusing
// the Strike Matrix's own execution-strike gate rather than inventing a
// second standard - this ladder names a strike to trade for exactly the same
// reason its recommendations do. Without it the delta floor surfaced 22,700
// CE at Δ0.99 on 65 traded and 260 OI, asking Rs 1,865 of premium.
function isTransactable(tick: OverviewTick) {
  return Boolean(
    tick.lastPrice && tick.lastPrice > 0 && (tick.volume ?? 0) > 0 && (tick.openInterest ?? 0) >= MIN_RECOMMENDATION_OPEN_INTEREST
  );
}

function pickByDelta(overview: MarketOverview, optionType: "CE" | "PE", targetDelta: number): OverviewTick | undefined {
  // Same reason as the S/R pivot above: measured against raw spot the ATM
  // strike counts as ITM for whichever side spot happens to sit below, so an
  // "at the money" band would quietly skip the Δ0.50 put and settle for the
  // Δ0.38 one a strike lower.
  const moneyPivot = overview.snapshot.atmStrike || overview.snapshot.spotPrice;
  let best: OverviewTick | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tick of overview.snapshot.ticks) {
    if (tick.optionType !== optionType) continue;
    const delta = tick.delta === undefined ? 0 : Math.abs(tick.delta);
    // Needs a real delta and a real premium to be transactable at all.
    if (delta <= 0 || !isTransactable(tick)) continue;
    // Only OTM-or-ATM strikes: writing deep ITM is a different trade from
    // the one this ladder describes.
    if (optionType === "CE" ? tick.strikePrice < moneyPivot : tick.strikePrice > moneyPivot) continue;
    const distance = Math.abs(delta - targetDelta);
    if (distance < bestDistance) {
      best = tick;
      bestDistance = distance;
    }
  }
  return best;
}

// Cheapest-first: the trader asked for delta at or above the floor, so the
// strike that just clears it is the one that costs least to express the view.
function pickAboveDelta(overview: MarketOverview, optionType: "CE" | "PE", floor: number, limit: number): OverviewTick[] {
  return overview.snapshot.ticks
    .filter((tick) => tick.optionType === optionType && Math.abs(tick.delta ?? 0) >= floor && isTransactable(tick))
    .sort((left, right) => Math.abs(left.delta ?? 0) - Math.abs(right.delta ?? 0))
    .slice(0, limit);
}

function buildSellLadder(overview: MarketOverview): LadderBand[] {
  return SELL_LADDER_BANDS.map(({ label, targetDelta }) => {
    const legs: LadderLeg[] = [];
    for (const optionType of ["PE", "CE"] as const) {
      const tick = pickByDelta(overview, optionType, targetDelta);
      if (!tick?.lastPrice) continue;
      const delta = Math.abs(tick.delta ?? 0);
      legs.push({
        optionType,
        strike: tick.strikePrice,
        price: tick.lastPrice,
        delta,
        // Delta approximates the chance of finishing ITM, so a short leg's
        // chance of expiring worthless is ~1 - |delta|.
        pop: Math.round((1 - delta) * 100)
      });
    }
    return {
      label,
      detail: `Δ${targetDelta.toFixed(2)}`,
      legs,
      credit: legs.length ? legs.reduce((sum, leg) => sum + leg.price, 0) : undefined,
      emptyNote: legs.length ? undefined : "No strike in this delta band."
    };
  });
}

function buildBuyLadder(overview: MarketOverview): LadderBand[] {
  const spot = overview.snapshot.spotPrice;
  return (["CE", "PE"] as const).map((optionType) => {
    const legs: LadderLeg[] = pickAboveDelta(overview, optionType, MIN_BUY_DELTA, BUY_CANDIDATES_PER_SIDE).map((tick) => {
      const price = tick.lastPrice ?? 0;
      const breakeven = optionType === "CE" ? tick.strikePrice + price : tick.strikePrice - price;
      return {
        optionType,
        strike: tick.strikePrice,
        price,
        delta: Math.abs(tick.delta ?? 0),
        breakeven,
        movePercent: spot > 0 ? ((breakeven - spot) / spot) * 100 : 0
      };
    });
    return {
      label: optionType === "CE" ? "Calls" : "Puts",
      detail: `Δ ≥ ${MIN_BUY_DELTA.toFixed(2)}`,
      legs,
      emptyNote: legs.length
        ? undefined
        : optionType === "CE"
          ? `No liquid call at Δ ≥ ${MIN_BUY_DELTA.toFixed(2)} — the feed reports no greeks for ITM calls.`
          : `No liquid put at Δ ≥ ${MIN_BUY_DELTA.toFixed(2)}.`
    };
  });
}

export function buildPremiumLadder(overview: MarketOverview, mode: ChainMode): LadderBand[] {
  return mode === "sell" ? buildSellLadder(overview) : buildBuyLadder(overview);
}

// --- OI movement rail --------------------------------------------------
// Where positions were opened and closed today, across the WHOLE chain
// rather than the visible window - a wall forming outside the expected-move
// range is exactly the kind of move worth catching early. Not available on
// any other tab.

export interface OiMovementRow {
  optionType: "CE" | "PE";
  strike: number;
  // Both in whatever unit the user picked - lots or raw contracts - so this
  // rail reads in the same units as the chain table beside it.
  change: number;
  openInterest: number;
}

const OI_MOVEMENT_ROWS_PER_DIRECTION = 4;

export function buildOiMovementRows(overview: MarketOverview, preferences: DisplayPreferences): { building: OiMovementRow[]; unwinding: OiMovementRow[] } {
  const getQuantity = (value: number | undefined, tick: OverviewTick) => (preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value ?? 0);
  const rows: OiMovementRow[] = overview.snapshot.ticks
    .filter((tick) => (tick.changeInOpenInterest ?? 0) !== 0)
    .map((tick) => ({
      optionType: tick.optionType,
      strike: tick.strikePrice,
      change: getQuantity(tick.changeInOpenInterest, tick),
      openInterest: getQuantity(tick.openInterest, tick)
    }));

  return {
    building: rows.filter((row) => row.change > 0).sort((left, right) => right.change - left.change).slice(0, OI_MOVEMENT_ROWS_PER_DIRECTION),
    unwinding: rows.filter((row) => row.change < 0).sort((left, right) => left.change - right.change).slice(0, OI_MOVEMENT_ROWS_PER_DIRECTION)
  };
}

function displayRankValue(lotsValue: number, rawValue: number, preferences: DisplayPreferences) {
  return preferences.quantityDisplayMode === "lots" ? lotsValue : rawValue;
}

function applyPressurePercents<T>(rows: T[], getValue: (row: T) => number, setPercent: (row: T, percent: number) => void) {
  const maxValue = Math.max(0, ...rows.map(getValue));
  for (const row of rows) {
    const percent = maxValue > 0 ? Math.round((getValue(row) / maxValue) * 100) : 0;
    setPercent(row, percent);
  }
}

function applyPressureRanks<T>(rows: T[], getValue: (row: T) => number, setRank: (row: T, rank: 1 | 2) => void) {
  const rankedRows = [...rows]
    .filter((row) => getValue(row) > 0)
    .sort((left, right) => getValue(right) - getValue(left))
    .slice(0, 2);

  rankedRows.forEach((row, index) => {
    setRank(row, (index + 1) as 1 | 2);
  });
}

export function buildTopStrikeRows(overview: MarketOverview, preferences: DisplayPreferences) {
  const getQuantity = (tick: OverviewTick) => (preferences.quantityDisplayMode === "lots" ? toLots(tick.openInterest, tick) : tick.openInterest ?? 0);
  return [...overview.snapshot.ticks]
    .filter((tick) => (tick.openInterest ?? 0) > 0)
    .sort((left, right) => getQuantity(right) - getQuantity(left))
    .slice(0, 4)
    .map((tick) => ({
      strike: tick.strikePrice,
      optionType: tick.optionType,
      openInterest: getQuantity(tick),
      changePercent: tick.openInterest ? ((tick.changeInOpenInterest ?? 0) / tick.openInterest) * 100 : 0
    }));
}

// Deliberately NOT reusing @option-decode/analytics' calculateChainStats
// here: that server-side version always sums raw contract-count OI, while
// this client version needs to optionally convert to lots depending on the
// user's quantityDisplayMode preference. The breadth boundary itself is
// imported rather than re-typed, so the two can never disagree on where
// dominance starts even though they aggregate differently.
export function buildChainStats(overview: MarketOverview, preferences: DisplayPreferences) {
  const ceTicks = overview.snapshot.ticks.filter((tick) => tick.optionType === "CE");
  const peTicks = overview.snapshot.ticks.filter((tick) => tick.optionType === "PE");
  const getQuantity = (value: number | undefined, tick: OverviewTick) => (preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value ?? 0);
  const totalCeOi = ceTicks.reduce((sum, tick) => sum + getQuantity(tick.openInterest, tick), 0);
  const totalPeOi = peTicks.reduce((sum, tick) => sum + getQuantity(tick.openInterest, tick), 0);
  const totalCeChange = ceTicks.reduce((sum, tick) => sum + getQuantity(tick.changeInOpenInterest, tick), 0);
  const totalPeChange = peTicks.reduce((sum, tick) => sum + getQuantity(tick.changeInOpenInterest, tick), 0);
  const maxOiTick = [...overview.snapshot.ticks].sort((left, right) => getQuantity(right.openInterest, right) - getQuantity(left.openInterest, left))[0];
  const breadth = totalPeOi > totalCeOi * OI_BREADTH_DOMINANCE_RATIO ? "Put Support" : totalCeOi > totalPeOi * OI_BREADTH_DOMINANCE_RATIO ? "Call Resistance" : "Balanced";

  return {
    totalCeOi,
    totalPeOi,
    totalCeChange,
    totalPeChange,
    breadth,
    maxOiStrikeText: maxOiTick ? `${formatStrike(maxOiTick.strikePrice)} ${maxOiTick.optionType}` : "--",
    maxOiSide: maxOiTick ? `${formatQuantityValue(maxOiTick.openInterest, maxOiTick, preferences)} OI` : "--"
  };
}

export type ChainStats = ReturnType<typeof buildChainStats>;
export type ChainRow = ReturnType<typeof buildChainRows>[number];
export type TopStrikeRow = ReturnType<typeof buildTopStrikeRows>[number];

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function formatLarge(value?: number, mode: NumberFormatMode = "indian") {
  if (value === undefined) {
    return "--";
  }
  const absoluteValue = Math.abs(value);
  if (mode === "metric") {
    if (absoluteValue >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(1)}B`;
    }
    if (absoluteValue >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (absoluteValue >= 1000) {
      return `${(value / 1000).toFixed(0)}K`;
    }
    return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }
  if (absoluteValue >= 10000000) {
    return `${(value / 10000000).toFixed(1)}Cr`;
  }
  if (absoluteValue >= 100000) {
    return `${(value / 100000).toFixed(1)}L`;
  }
  if (absoluteValue >= 1000) {
    return `${(value / 1000).toFixed(0)}K`;
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function toLots(value: number | undefined, tick?: Pick<OverviewTick, "lotSize" | "underlyingSymbol">) {
  const lotSize = tick?.lotSize && tick.lotSize > 0 ? tick.lotSize : getLotSizeForUnderlying(tick?.underlyingSymbol);
  return (value ?? 0) / lotSize;
}

function formatQuantityValue(value: number | undefined, tick: OverviewTick | undefined, preferences: DisplayPreferences, signed = false) {
  if (value === undefined) {
    return "--";
  }
  const displayValue = preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value;
  const sign = signed && displayValue >= 0 ? "+" : "";
  return `${sign}${formatLarge(displayValue, preferences.numberFormatMode)}`;
}

function getLotSizeForUnderlying(underlyingSymbol?: string) {
  const lotSizes: Record<string, number> = {
    NIFTY: 65,
    BANKNIFTY: 30,
    FINNIFTY: 60,
    MIDCPNIFTY: 120,
    NIFTYNXT50: 25,
    SENSEX: 20,
    BANKEX: 30,
    CRUDEOIL: 100,
    NATURALGAS: 1250,
    COPPER: 2500,
    SILVER: 30
  };
  return lotSizes[String(underlyingSymbol ?? "").toUpperCase()] ?? 1;
}
