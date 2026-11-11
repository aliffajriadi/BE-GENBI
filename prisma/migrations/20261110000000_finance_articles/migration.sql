-- AlterTable
ALTER TABLE `Article` ADD COLUMN `coverAlt` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `DuesPlan` ADD COLUMN `divisionId` VARCHAR(191) NULL,
    ADD COLUMN `dueDate` DATETIME(3) NULL,
    ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE `DuesPlan` ADD CONSTRAINT `DuesPlan_divisionId_fkey` FOREIGN KEY (`divisionId`) REFERENCES `Division`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

