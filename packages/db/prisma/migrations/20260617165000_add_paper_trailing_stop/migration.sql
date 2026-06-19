ALTER TABLE `PaperOrder`
  ADD COLUMN `trailingStop` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `trailDistance` DECIMAL(12, 2) NULL;

ALTER TABLE `PaperPosition`
  ADD COLUMN `trailingStop` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `trailDistance` DECIMAL(12, 2) NULL,
  ADD COLUMN `bestPrice` DECIMAL(12, 2) NULL;
