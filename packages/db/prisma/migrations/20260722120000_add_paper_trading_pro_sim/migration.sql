-- Paper Trading Pro (seller strategy simulator).
-- Fully separate from the existing PaperOrder/PaperPosition/PaperTrade
-- module: new Sim* tables only, no existing table is altered.

-- CreateTable
CREATE TABLE `SimAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL DEFAULT 'Default',
    `startingCapital` DECIMAL(16, 2) NOT NULL,
    `cash` DECIMAL(16, 2) NOT NULL,
    `maxTradeBpPct` DECIMAL(5, 2) NOT NULL DEFAULT 5.00,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `resetAt` DATETIME(3) NULL,

    INDEX `SimAccount_userId_isActive_idx`(`userId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimTrade` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `strategyType` ENUM('SHORT_STRADDLE', 'BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD', 'IRON_CONDOR', 'NAKED_CALL', 'NAKED_PUT') NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `expiryDate` DATE NOT NULL,
    `horizon` ENUM('INTRADAY', 'WEEKLY', 'MONTHLY') NOT NULL,
    `lotSize` INTEGER NOT NULL,
    `lots` INTEGER NOT NULL,
    `status` ENUM('OPEN', 'CLOSED', 'EXPIRED', 'LIQUIDATED') NOT NULL DEFAULT 'OPEN',
    `netCredit` DECIMAL(14, 2) NOT NULL,
    `maxLoss` DECIMAL(14, 2) NULL,
    `bpe` DECIMAL(16, 2) NOT NULL,
    `underlyingAtEntry` DECIMAL(12, 2) NOT NULL,
    `ivAtEntry` DECIMAL(10, 4) NULL,
    `hv20AtEntry` DECIMAL(10, 4) NULL,
    `ivHvRatio` DECIMAL(10, 4) NULL,
    `lowEdgeFlag` BOOLEAN NOT NULL DEFAULT false,
    `entryWci` DECIMAL(10, 4) NULL,
    `entryDrcr` DECIMAL(10, 4) NULL,
    `signalRef` VARCHAR(191) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `exitReason` VARCHAR(191) NULL,
    `realizedPnl` DECIMAL(14, 2) NULL,

    INDEX `SimTrade_accountId_status_idx`(`accountId`, `status`),
    INDEX `SimTrade_underlyingSymbol_expiryLabel_status_idx`(`underlyingSymbol`, `expiryLabel`, `status`),
    INDEX `SimTrade_status_expiryDate_idx`(`status`, `expiryDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimLeg` (
    `id` VARCHAR(191) NOT NULL,
    `tradeId` VARCHAR(191) NOT NULL,
    `side` ENUM('SELL', 'BUY') NOT NULL,
    `optionType` ENUM('CE', 'PE') NOT NULL,
    `strikePrice` DECIMAL(12, 2) NOT NULL,
    `midAtFill` DECIMAL(12, 2) NOT NULL,
    `bidAtFill` DECIMAL(12, 2) NOT NULL,
    `askAtFill` DECIMAL(12, 2) NOT NULL,
    `slippageChi` DECIMAL(4, 2) NOT NULL,
    `fillPrice` DECIMAL(12, 2) NOT NULL,
    `oiAtFill` DECIMAL(20, 2) NULL,
    `deltaAtFill` DECIMAL(10, 6) NULL,
    `ivAtFill` DECIMAL(10, 4) NULL,
    `closeFillPrice` DECIMAL(12, 2) NULL,

    INDEX `SimLeg_tradeId_idx`(`tradeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimMtmSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `tradeId` VARCHAR(191) NOT NULL,
    `ts` DATETIME(3) NOT NULL,
    `closeCost` DECIMAL(14, 2) NOT NULL,
    `pnl` DECIMAL(14, 2) NOT NULL,
    `netDelta` DECIMAL(12, 4) NULL,
    `netGamma` DECIMAL(12, 6) NULL,
    `netTheta` DECIMAL(12, 2) NULL,
    `netVega` DECIMAL(12, 2) NULL,
    `marginReq` DECIMAL(16, 2) NULL,

    INDEX `SimMtmSnapshot_ts_idx`(`ts`),
    UNIQUE INDEX `SimMtmSnapshot_tradeId_ts_key`(`tradeId`, `ts`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimExitEvent` (
    `id` VARCHAR(191) NOT NULL,
    `tradeId` VARCHAR(191) NOT NULL,
    `rule` ENUM('PROFIT_TARGET', 'HARD_STOP_3X', 'DTE_GAMMA', 'EXPIRY_ITM', 'DELTA_2X_INTRADAY', 'MARGIN_CALL') NOT NULL,
    `action` ENUM('FLAGGED', 'AUTO_CLOSED', 'LIQUIDATED') NOT NULL,
    `detail` VARCHAR(255) NULL,
    `triggeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SimExitEvent_tradeId_rule_idx`(`tradeId`, `rule`),
    INDEX `SimExitEvent_triggeredAt_idx`(`triggeredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SimAccount` ADD CONSTRAINT `SimAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimTrade` ADD CONSTRAINT `SimTrade_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `SimAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimLeg` ADD CONSTRAINT `SimLeg_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `SimTrade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimMtmSnapshot` ADD CONSTRAINT `SimMtmSnapshot_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `SimTrade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimExitEvent` ADD CONSTRAINT `SimExitEvent_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `SimTrade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
