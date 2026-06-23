ALTER TABLE `User`
  ADD COLUMN `disabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `lastLoginAt` DATETIME(3) NULL;

CREATE INDEX `EmailVerificationToken_tokenHash_idx`
  ON `EmailVerificationToken`(`tokenHash`);

CREATE TABLE `PasswordResetToken` (
  `id` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `tokenHash` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `PasswordResetToken_email_expiresAt_idx`(`email`, `expiresAt`),
  INDEX `PasswordResetToken_tokenHash_idx`(`tokenHash`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
