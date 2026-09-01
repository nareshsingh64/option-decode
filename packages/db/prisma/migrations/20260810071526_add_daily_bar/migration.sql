-- CreateTable
CREATE TABLE `DailyBar` (
    `symbol` VARCHAR(32) NOT NULL,
    `date` DATE NOT NULL,
    `open` DECIMAL(14, 2) NOT NULL,
    `high` DECIMAL(14, 2) NOT NULL,
    `low` DECIMAL(14, 2) NOT NULL,
    `close` DECIMAL(14, 2) NOT NULL,
    `prevClose` DECIMAL(14, 2) NULL,
    `volume` BIGINT NOT NULL,
    `trades` BIGINT NULL,
    `turnover` DECIMAL(20, 2) NULL,
    `series` VARCHAR(4) NOT NULL,
    `source` VARCHAR(16) NOT NULL DEFAULT 'NSE_UDIFF',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DailyBar_date_idx`(`date`),
    PRIMARY KEY (`symbol`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
