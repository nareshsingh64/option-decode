-- Elliott Wave background screener (Phase 2 of the Elliott Wave tab):
-- an F&O stock universe, a lightweight price+volume series for stocks
-- (indices keep using the existing OptionChainSnapshot spot-price series),
-- and persisted screener alerts.

-- CreateTable
CREATE TABLE `FnoStock` (
    `id` VARCHAR(191) NOT NULL,
    `symbol` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `securityId` INTEGER NULL,
    `lotSize` INTEGER NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `lastSyncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FnoStock_symbol_key`(`symbol`),
    INDEX `FnoStock_active_idx`(`active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WavePricePoint` (
    `id` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `time` DATETIME(3) NOT NULL,
    `price` DECIMAL(12, 2) NOT NULL,
    `volume` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WavePricePoint_underlyingSymbol_time_key`(`underlyingSymbol`, `time`),
    INDEX `WavePricePoint_underlyingSymbol_time_idx`(`underlyingSymbol`, `time`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WaveScreenerAlert` (
    `id` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `alertType` ENUM('WAVE2_REVERSAL', 'WAVE3_IMPULSE') NOT NULL,
    `horizon` VARCHAR(191) NOT NULL,
    `stage` VARCHAR(191) NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `triggeredPrice` DECIMAL(12, 2) NOT NULL,
    `fibRetracementPercent` DECIMAL(6, 2) NULL,
    `rvol` DECIMAL(6, 2) NULL,
    `rsi` DECIMAL(6, 2) NULL,
    `dismissed` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WaveScreenerAlert_underlyingSymbol_alertType_createdAt_idx`(`underlyingSymbol`, `alertType`, `createdAt`),
    INDEX `WaveScreenerAlert_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
