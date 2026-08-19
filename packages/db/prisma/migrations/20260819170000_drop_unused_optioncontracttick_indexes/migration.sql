-- Drop three OptionContractTick indexes that a full trading day of
-- performance_schema counters recorded ZERO reads and ZERO writes on, while
-- the table took 3.1M inserts and 51.5M index reads through the others.
--
--   [tradingDate, underlyingSymbol, expiryLabel, optionType, strikePrice, tickTime]  9.17 GB
--   [underlyingSymbol, expiryLabel, tradingDate, optionType, strikePrice, tickTime]  9.16 GB
--   [tickTime]                                                                       3.45 GB
--
-- 21.8 GB of a 33.7 GB secondary-index footprint on a 91M-row table.
--
-- NOTE ON DISK: with innodb_file_per_table these pages return to the
-- tablespace free list, not to the OS - the .ibd does not shrink without an
-- OPTIMIZE TABLE rebuild, which is deliberately NOT done here (91M rows,
-- ~20GB of temp space). The win is insert and delete throughput plus buffer
-- pool headroom, and the freed pages absorb future growth.

-- DropIndex
DROP INDEX `OptionContractTick_tradingDate_underlyingSymbol_expiryLabel__idx` ON `OptionContractTick`;

-- DropIndex
DROP INDEX `OptionContractTick_underlyingSymbol_expiryLabel_tradingDate__idx` ON `OptionContractTick`;

-- DropIndex
DROP INDEX `OptionContractTick_tickTime_idx` ON `OptionContractTick`;
