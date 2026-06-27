CREATE TABLE `AlertThreshold` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `underlyingSymbol` VARCHAR(191) NOT NULL,
  `proximityPoints` DECIMAL(12, 2) NOT NULL,
  `pcrUpper` DECIMAL(10, 4) NOT NULL,
  `pcrLower` DECIMAL(10, 4) NOT NULL,
  `pressureWarning` INTEGER NOT NULL DEFAULT 55,
  `pressureCritical` INTEGER NOT NULL DEFAULT 62,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PushSubscription` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `endpoint` VARCHAR(768) NOT NULL,
  `p256dh` VARCHAR(255) NOT NULL,
  `auth` VARCHAR(255) NOT NULL,
  `userAgent` VARCHAR(255) NULL,
  `disabled` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `AlertThreshold_userId_underlyingSymbol_key` ON `AlertThreshold`(`userId`, `underlyingSymbol`);
CREATE INDEX `AlertThreshold_underlyingSymbol_idx` ON `AlertThreshold`(`underlyingSymbol`);
CREATE UNIQUE INDEX `PushSubscription_userId_endpoint_key` ON `PushSubscription`(`userId`, `endpoint`);
CREATE INDEX `PushSubscription_userId_disabled_idx` ON `PushSubscription`(`userId`, `disabled`);

ALTER TABLE `AlertThreshold` ADD CONSTRAINT `AlertThreshold_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PushSubscription` ADD CONSTRAINT `PushSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
