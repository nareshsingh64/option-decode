-- Framework for weighted F&O stock option-chain capture (see FnoStock.indexWeightPercent
-- comment in schema.prisma). Column stays NULL for every stock until weight data is
-- explicitly seeded via setFnoStockIndexWeight, so this migration has zero behavioral
-- effect on its own.
ALTER TABLE `FnoStock` ADD COLUMN `indexWeightPercent` DECIMAL(6, 3) NULL;

CREATE INDEX `FnoStock_indexWeightPercent_idx` ON `FnoStock`(`indexWeightPercent`);
