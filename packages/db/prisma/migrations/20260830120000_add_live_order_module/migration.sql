-- CreateTable
CREATE TABLE `UserBrokerCredential` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `broker` VARCHAR(191) NOT NULL DEFAULT 'DHAN',
    `brokerClientId` VARCHAR(191) NOT NULL,
    `tokenCipher` LONGBLOB NOT NULL,
    `tokenIv` LONGBLOB NOT NULL,
    `tokenTag` LONGBLOB NOT NULL,
    `keyVersion` INTEGER NOT NULL DEFAULT 1,
    `tokenExpiresAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `verifiedOk` BOOLEAN NOT NULL DEFAULT false,
    `renewable` BOOLEAN NOT NULL DEFAULT false,
    `lastRenewalAt` DATETIME(3) NULL,
    `lastRenewalMsg` VARCHAR(255) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserBrokerCredential_tokenExpiresAt_idx`(`tokenExpiresAt`),
    UNIQUE INDEX `UserBrokerCredential_userId_broker_key`(`userId`, `broker`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `brokerClientId` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `tradingEnabled` BOOLEAN NOT NULL DEFAULT false,
    `maxOrderMargin` DECIMAL(16, 2) NOT NULL DEFAULT 40000.00,
    `maxOpenMargin` DECIMAL(16, 2) NOT NULL DEFAULT 60000.00,
    `dailyLossLimit` DECIMAL(16, 2) NOT NULL DEFAULT 5000.00,
    `maxMarginUtilPct` DECIMAL(5, 2) NOT NULL DEFAULT 50.00,
    `maxOrdersPerMinute` INTEGER NOT NULL DEFAULT 6,
    `allowUndefinedRisk` BOOLEAN NOT NULL DEFAULT false,
    `lotCeilings` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LiveAccount_userId_isActive_idx`(`userId`, `isActive`),
    UNIQUE INDEX `LiveAccount_userId_brokerClientId_key`(`userId`, `brokerClientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveOrder` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NULL,
    `legRole` VARCHAR(191) NOT NULL DEFAULT 'MAIN',
    `correlationId` VARCHAR(64) NOT NULL,
    `brokerOrderId` VARCHAR(64) NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `expiryLabel` VARCHAR(191) NOT NULL,
    `optionType` ENUM('CE', 'PE') NOT NULL,
    `strikePrice` DECIMAL(12, 2) NOT NULL,
    `securityId` VARCHAR(191) NOT NULL,
    `exchangeSegment` VARCHAR(16) NOT NULL,
    `transactionType` VARCHAR(8) NOT NULL,
    `productType` VARCHAR(16) NOT NULL,
    `orderType` VARCHAR(24) NOT NULL,
    `lots` INTEGER NOT NULL,
    `lotSize` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL,
    `notional` DECIMAL(16, 2) NOT NULL,
    `price` DECIMAL(12, 2) NULL,
    `triggerPrice` DECIMAL(12, 2) NULL,
    `status` ENUM('LOCAL_PENDING', 'SENT', 'OPEN', 'PARTIAL', 'TRADED', 'CANCELLED', 'REJECTED', 'UNKNOWN') NOT NULL DEFAULT 'LOCAL_PENDING',
    `brokerStatusRaw` VARCHAR(64) NULL,
    `rejectionReason` VARCHAR(255) NULL,
    `filledQty` INTEGER NOT NULL DEFAULT 0,
    `avgFillPrice` DECIMAL(12, 2) NULL,
    `quotedAt` DATETIME(3) NULL,
    `quotedPrice` DECIMAL(12, 2) NULL,
    `quotedMargin` DECIMAL(16, 2) NULL,
    `signalRef` VARCHAR(191) NULL,
    `placedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LiveOrder_correlationId_key`(`correlationId`),
    UNIQUE INDEX `LiveOrder_brokerOrderId_key`(`brokerOrderId`),
    INDEX `LiveOrder_accountId_status_idx`(`accountId`, `status`),
    INDEX `LiveOrder_groupId_idx`(`groupId`),
    INDEX `LiveOrder_accountId_placedAt_idx`(`accountId`, `placedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveOrderEvent` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `source` VARCHAR(24) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `payload` JSON NOT NULL,
    `observedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LiveOrderEvent_orderId_observedAt_idx`(`orderId`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LivePosition` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NULL,
    `securityId` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `exchangeSegment` VARCHAR(16) NOT NULL,
    `expiryLabel` VARCHAR(191) NULL,
    `optionType` ENUM('CE', 'PE') NULL,
    `strikePrice` DECIMAL(12, 2) NULL,
    `tradingSymbol` VARCHAR(191) NULL,
    `netQty` INTEGER NOT NULL,
    `avgCostPrice` DECIMAL(12, 2) NOT NULL,
    `lotSize` INTEGER NULL,
    `multiplier` INTEGER NULL,
    `lastPrice` DECIMAL(12, 2) NULL,
    `unrealizedPnl` DECIMAL(14, 2) NULL,
    `realizedPnl` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `reconciledAt` DATETIME(3) NOT NULL,

    INDEX `LivePosition_accountId_status_idx`(`accountId`, `status`),
    UNIQUE INDEX `LivePosition_accountId_securityId_status_key`(`accountId`, `securityId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveMarginSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `asOf` DATETIME(3) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `totalMargin` DECIMAL(16, 2) NOT NULL,
    `available` DECIMAL(16, 2) NOT NULL,
    `payload` JSON NOT NULL,

    INDEX `LiveMarginSnapshot_accountId_asOf_idx`(`accountId`, `asOf`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `UserBrokerCredential` ADD CONSTRAINT `UserBrokerCredential_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveAccount` ADD CONSTRAINT `LiveAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveOrder` ADD CONSTRAINT `LiveOrder_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `LiveAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveOrderEvent` ADD CONSTRAINT `LiveOrderEvent_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `LiveOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LivePosition` ADD CONSTRAINT `LivePosition_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `LiveAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveMarginSnapshot` ADD CONSTRAINT `LiveMarginSnapshot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `LiveAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

