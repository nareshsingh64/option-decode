-- Extra high-volume market-data indexes can live here when Prisma migrations are
-- not expressive enough for a specific MySQL optimization.

CREATE INDEX idx_ticks_replay_lookup
  ON OptionContractTick (tradingDate, underlyingSymbol, expiryLabel, tickTime, strikePrice, optionType);
