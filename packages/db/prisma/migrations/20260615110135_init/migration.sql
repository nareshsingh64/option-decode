-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NULL,
    `role` ENUM('ADMIN', 'SUBSCRIBER', 'TRIAL', 'FREE') NOT NULL DEFAULT 'FREE',
    `emailVerified` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailVerificationToken` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmailVerificationToken_email_expiresAt_idx`(`email`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Plan` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `monthlyPrice` DECIMAL(10, 2) NULL,
    `replayLimit` INTEGER NULL,
    `realtime` BOOLEAN NOT NULL DEFAULT false,
    `premiumAlerts` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Plan_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Subscription` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Subscription_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Underlying` (
    `id` VARCHAR(191) NOT NULL,
    `symbol` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `exchange` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Underlying_symbol_key`(`symbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Expiry` (
    `id` VARCHAR(191) NOT NULL,
    `underlyingId` VARCHAR(191) NOT NULL,
    `expiryDate` DATE NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,

    INDEX `Expiry_underlyingId_active_expiryDate_idx`(`underlyingId`, `active`, `expiryDate`),
    UNIQUE INDEX `Expiry_underlyingId_expiryDate_key`(`underlyingId`, `expiryDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OptionContract` (
    `id` VARCHAR(191) NOT NULL,
    `expiryId` VARCHAR(191) NOT NULL,
    `optionType` ENUM('CE', 'PE') NOT NULL,
    `strikePrice` DECIMAL(12, 2) NOT NULL,
    `securityId` VARCHAR(191) NULL,
    `lotSize` INTEGER NULL,
    `tickSize` DECIMAL(8, 4) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,

    INDEX `OptionContract_securityId_idx`(`securityId`),
    UNIQUE INDEX `OptionContract_expiryId_optionType_strikePrice_key`(`expiryId`, `optionType`, `strikePrice`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OptionChainSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `tradingDate` DATE NOT NULL,
    `snapshotTime` DATETIME(3) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryId` VARCHAR(191) NOT NULL,
    `spotPrice` DECIMAL(12, 2) NOT NULL,
    `atmStrike` DECIMAL(12, 2) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'DHAN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OptionChainSnapshot_tradingDate_underlyingSymbol_snapshotTim_idx`(`tradingDate`, `underlyingSymbol`, `snapshotTime`),
    INDEX `OptionChainSnapshot_underlyingSymbol_expiryId_snapshotTime_idx`(`underlyingSymbol`, `expiryId`, `snapshotTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OptionContractTick` (
    `id` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `tradingDate` DATE NOT NULL,
    `tickTime` DATETIME(3) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `optionType` ENUM('CE', 'PE') NOT NULL,
    `strikePrice` DECIMAL(12, 2) NOT NULL,
    `securityId` VARCHAR(191) NULL,
    `lastPrice` DECIMAL(12, 2) NULL,
    `bidPrice` DECIMAL(12, 2) NULL,
    `askPrice` DECIMAL(12, 2) NULL,
    `volume` DECIMAL(20, 2) NULL,
    `openInterest` DECIMAL(20, 2) NULL,
    `changeInOpenInterest` DECIMAL(20, 2) NULL,
    `impliedVolatility` DECIMAL(10, 4) NULL,
    `deltaValue` DECIMAL(10, 6) NULL,
    `gammaValue` DECIMAL(10, 6) NULL,
    `thetaValue` DECIMAL(10, 6) NULL,
    `vegaValue` DECIMAL(10, 6) NULL,

    INDEX `OptionContractTick_tradingDate_underlyingSymbol_expiryLabel__idx`(`tradingDate`, `underlyingSymbol`, `expiryLabel`, `optionType`, `strikePrice`, `tickTime`),
    INDEX `OptionContractTick_tickTime_idx`(`tickTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PressureScore` (
    `id` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `scoreTime` DATETIME(3) NOT NULL,
    `bullishPressure` INTEGER NOT NULL,
    `bearishPressure` INTEGER NOT NULL,
    `pcr` DECIMAL(10, 4) NULL,
    `maxPain` DECIMAL(12, 2) NULL,
    `payloadJson` JSON NULL,

    INDEX `PressureScore_underlyingSymbol_expiryLabel_scoreTime_idx`(`underlyingSymbol`, `expiryLabel`, `scoreTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Watchlist` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `symbols` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Watchlist_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReplaySession` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `tradingDate` DATE NOT NULL,
    `currentTime` DATETIME(3) NOT NULL,
    `speed` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReplaySession_userId_tradingDate_underlyingSymbol_idx`(`userId`, `tradingDate`, `underlyingSymbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaperOrder` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tradingDate` DATE NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `optionType` ENUM('CE', 'PE') NOT NULL,
    `strikePrice` DECIMAL(12, 2) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `requestedPrice` DECIMAL(12, 2) NOT NULL,
    `filledPrice` DECIMAL(12, 2) NULL,
    `stopLoss` DECIMAL(12, 2) NOT NULL,
    `targetPrice` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('PENDING', 'FILLED', 'CANCELLED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `strategyName` VARCHAR(191) NOT NULL,
    `reasonText` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PaperOrder_userId_tradingDate_status_idx`(`userId`, `tradingDate`, `status`),
    INDEX `PaperOrder_tradingDate_underlyingSymbol_status_idx`(`tradingDate`, `underlyingSymbol`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaperPosition` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `tradingDate` DATE NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `optionType` ENUM('CE', 'PE') NOT NULL,
    `strikePrice` DECIMAL(12, 2) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `entryPrice` DECIMAL(12, 2) NOT NULL,
    `currentPrice` DECIMAL(12, 2) NOT NULL,
    `stopLoss` DECIMAL(12, 2) NOT NULL,
    `targetPrice` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `realizedPnl` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `openedAt` DATETIME(3) NOT NULL,
    `closedAt` DATETIME(3) NULL,
    `exitReason` VARCHAR(191) NULL,

    UNIQUE INDEX `PaperPosition_orderId_key`(`orderId`),
    INDEX `PaperPosition_userId_tradingDate_status_idx`(`userId`, `tradingDate`, `status`),
    INDEX `PaperPosition_tradingDate_underlyingSymbol_status_idx`(`tradingDate`, `underlyingSymbol`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaperTrade` (
    `id` VARCHAR(191) NOT NULL,
    `positionId` VARCHAR(191) NOT NULL,
    `entryPrice` DECIMAL(12, 2) NOT NULL,
    `exitPrice` DECIMAL(12, 2) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `grossPnl` DECIMAL(14, 2) NOT NULL,
    `charges` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `netPnl` DECIMAL(14, 2) NOT NULL,
    `exitReason` VARCHAR(191) NOT NULL,
    `closedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaperTrade_positionId_key`(`positionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BacktestRun` (
    `id` VARCHAR(191) NOT NULL,
    `strategyName` VARCHAR(191) NOT NULL,
    `strategyVersion` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `dateFrom` DATE NOT NULL,
    `dateTo` DATE NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `configJson` JSON NULL,
    `resultJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `Plan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Expiry` ADD CONSTRAINT `Expiry_underlyingId_fkey` FOREIGN KEY (`underlyingId`) REFERENCES `Underlying`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OptionContract` ADD CONSTRAINT `OptionContract_expiryId_fkey` FOREIGN KEY (`expiryId`) REFERENCES `Expiry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OptionChainSnapshot` ADD CONSTRAINT `OptionChainSnapshot_expiryId_fkey` FOREIGN KEY (`expiryId`) REFERENCES `Expiry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OptionContractTick` ADD CONSTRAINT `OptionContractTick_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `OptionChainSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PressureScore` ADD CONSTRAINT `PressureScore_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `OptionChainSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Watchlist` ADD CONSTRAINT `Watchlist_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaperOrder` ADD CONSTRAINT `PaperOrder_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaperPosition` ADD CONSTRAINT `PaperPosition_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaperPosition` ADD CONSTRAINT `PaperPosition_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `PaperOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaperTrade` ADD CONSTRAINT `PaperTrade_positionId_fkey` FOREIGN KEY (`positionId`) REFERENCES `PaperPosition`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
