-- Multi-leg (hedge) paper orders: legs submitted together in one ticket
-- share a groupId so they can be displayed/tracked as one strategy.
ALTER TABLE `PaperOrder` ADD COLUMN `groupId` VARCHAR(191) NULL;
ALTER TABLE `PaperOrder` ADD COLUMN `legRole` VARCHAR(191) NOT NULL DEFAULT 'MAIN';
CREATE INDEX `PaperOrder_groupId_idx` ON `PaperOrder`(`groupId`);

-- Informational-only margin snapshot (Dhan margin calculator, captured at
-- fill time using actual fill price/quantity), plus the same leg-grouping
-- mirrored from the originating order.
ALTER TABLE `PaperPosition` ADD COLUMN `groupId` VARCHAR(191) NULL;
ALTER TABLE `PaperPosition` ADD COLUMN `legRole` VARCHAR(191) NOT NULL DEFAULT 'MAIN';
ALTER TABLE `PaperPosition` ADD COLUMN `marginRequired` DECIMAL(14, 2) NULL;
ALTER TABLE `PaperPosition` ADD COLUMN `marginBreakdown` JSON NULL;
CREATE INDEX `PaperPosition_groupId_idx` ON `PaperPosition`(`groupId`);
