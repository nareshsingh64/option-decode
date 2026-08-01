-- AlterTable
ALTER TABLE `SimMtmSnapshot` ADD COLUMN `source` ENUM('EOD', 'INTRADAY') NOT NULL DEFAULT 'EOD';

-- Backfill existing rows: the DEFAULT above tags every pre-existing row
-- as EOD, which is wrong for the (majority) intraday ones already in the
-- table. runSimEodMarkToMarket always normalizes `ts` to exact midnight
-- UTC (see the `ts = new Date(...T00:00:00.000Z)` construction in
-- sim-repository.ts); runSimIntradayEngine always writes the real `asOf`
-- timestamp, which is never exactly midnight. Comparing `ts` to `DATE(ts)`
-- (which coerces to midnight) reliably tells the two apart after the fact.
UPDATE `SimMtmSnapshot` SET `source` = 'INTRADAY' WHERE `ts` <> DATE(`ts`);
