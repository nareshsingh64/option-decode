-- Audit trail for every authenticated Dhan API request, tagged by which
-- feature/call-site issued it. Written fire-and-forget from DhanClient's
-- postDhan() choke point (see @option-decode/dhan), so this table has zero
-- effect on the actual Dhan request path.
CREATE TABLE `DhanApiRequestLog` (
  `id` VARCHAR(191) NOT NULL,
  `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `endpoint` VARCHAR(191) NOT NULL,
  `caller` VARCHAR(191) NOT NULL,
  `statusCode` INT NULL,
  `success` BOOLEAN NOT NULL,
  `durationMs` INT NOT NULL,
  `errorMessage` VARCHAR(500) NULL,

  PRIMARY KEY (`id`)
);

CREATE INDEX `DhanApiRequestLog_requestedAt_idx` ON `DhanApiRequestLog`(`requestedAt`);
CREATE INDEX `DhanApiRequestLog_caller_requestedAt_idx` ON `DhanApiRequestLog`(`caller`, `requestedAt`);
CREATE INDEX `DhanApiRequestLog_endpoint_requestedAt_idx` ON `DhanApiRequestLog`(`endpoint`, `requestedAt`);
