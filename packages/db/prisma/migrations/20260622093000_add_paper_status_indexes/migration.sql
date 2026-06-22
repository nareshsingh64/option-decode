CREATE INDEX `PaperOrder_status_createdAt_idx` ON `PaperOrder`(`status`, `createdAt`);

CREATE INDEX `PaperPosition_status_openedAt_idx` ON `PaperPosition`(`status`, `openedAt`);
