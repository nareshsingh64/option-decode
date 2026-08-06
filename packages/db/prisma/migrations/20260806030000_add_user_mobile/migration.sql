-- Mobile number on the user account.
--
-- Nullable deliberately. Existing accounts predate this column and have no
-- number; a NOT NULL column would need a fabricated default, which would be
-- indistinguishable from a real number later. Registration enforces it at the
-- API instead, so every account created from now on has one.
ALTER TABLE `User` ADD COLUMN `mobile` VARCHAR(20) NULL;
