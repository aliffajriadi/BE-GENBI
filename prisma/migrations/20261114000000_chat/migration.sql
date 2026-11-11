-- AlterTable
ALTER TABLE `Channel` ADD COLUMN `key` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Message` ADD COLUMN `editedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Channel_key_key` ON `Channel`(`key`);

