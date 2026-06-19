import type { OptionChainSnapshot } from "@option-decode/types";

export function buildDemoSnapshot(now = new Date()): OptionChainSnapshot {
  const tradingDate = now.toISOString().slice(0, 10);
  const strikes = [23300, 23350, 23400, 23450, 23500, 23550, 23600];

  return {
    tradingDate,
    snapshotTime: now.toISOString(),
    underlyingSymbol: "NIFTY",
    expiry: "2026-06-18",
    spotPrice: 23472.25,
    atmStrike: 23500,
    ticks: strikes.flatMap((strikePrice, index) => [
      {
        tradingDate,
        tickTime: now.toISOString(),
        underlyingSymbol: "NIFTY",
        expiry: "2026-06-18",
        optionType: "PE",
        strikePrice,
        lastPrice: 80 + index * 8,
        volume: 260000 - index * 12000,
        openInterest: 920000 + index * 54000,
        changeInOpenInterest: 44000 + index * 8000
      },
      {
        tradingDate,
        tickTime: now.toISOString(),
        underlyingSymbol: "NIFTY",
        expiry: "2026-06-18",
        optionType: "CE",
        strikePrice,
        lastPrice: 126 - index * 7,
        volume: 230000 + index * 10000,
        openInterest: 860000 + (strikes.length - index) * 42000,
        changeInOpenInterest: 36000 + (strikes.length - index) * 6000
      }
    ])
  };
}
