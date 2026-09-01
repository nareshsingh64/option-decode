-- AlterTable
ALTER TABLE `LivePosition` ADD COLUMN `stopPrice` DECIMAL(12, 2) NULL,
    ADD COLUMN `stopSetAt` DATETIME(3) NULL;

