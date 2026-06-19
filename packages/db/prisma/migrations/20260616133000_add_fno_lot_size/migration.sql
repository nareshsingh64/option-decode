-- CreateTable
CREATE TABLE `FnoLotSize` (
    `id` VARCHAR(191) NOT NULL,
    `symbol` VARCHAR(191) NOT NULL,
    `contractMonth` DATE NOT NULL,
    `monthLabel` VARCHAR(191) NOT NULL,
    `lotSize` INTEGER NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'DHAN',
    `sourceUrl` VARCHAR(191) NOT NULL,
    `fetchedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `FnoLotSize_symbol_contractMonth_key`(`symbol`, `contractMonth`),
    INDEX `FnoLotSize_contractMonth_idx`(`contractMonth`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
