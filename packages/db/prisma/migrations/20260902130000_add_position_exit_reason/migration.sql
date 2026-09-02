-- AlterTable
ALTER TABLE `LivePosition` ADD COLUMN `exitReason` VARCHAR(32) NULL,
    ADD COLUMN `exitDetail` VARCHAR(255) NULL;
