-- AlterTable
ALTER TABLE `LiveAccount` ADD COLUMN `autoExitEnabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `LiveExitEvent` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NOT NULL,
    `rule` VARCHAR(24) NOT NULL,
    `action` ENUM('FLAGGED', 'AUTO_CLOSED', 'FAILED') NOT NULL,
    `detail` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LiveExitEvent_accountId_createdAt_idx`(`accountId`, `createdAt`),
    UNIQUE INDEX `LiveExitEvent_groupId_rule_key`(`groupId`, `rule`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

