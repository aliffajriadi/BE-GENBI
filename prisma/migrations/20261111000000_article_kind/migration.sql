-- AlterTable
ALTER TABLE `Article` ADD COLUMN `kind` ENUM('NEWS', 'PERSONAL') NOT NULL DEFAULT 'PERSONAL';

-- CreateIndex
CREATE INDEX `Article_status_kind_publishedAt_idx` ON `Article`(`status`, `kind`, `publishedAt`);

