-- AlterTable
ALTER TABLE `BankAccount` ADD COLUMN `treasuryDivisionId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `DuesPlan` ADD COLUMN `treasuryDivisionId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Payment` ADD COLUMN `treasuryDivisionId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `CashTransaction` ADD COLUMN `treasuryDivisionId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `BankAccount_treasuryDivisionId_idx` ON `BankAccount`(`treasuryDivisionId`);

-- CreateIndex
CREATE INDEX `DuesPlan_treasuryDivisionId_idx` ON `DuesPlan`(`treasuryDivisionId`);

-- CreateIndex
CREATE INDEX `Payment_treasuryDivisionId_idx` ON `Payment`(`treasuryDivisionId`);

-- CreateIndex
CREATE INDEX `CashTransaction_treasuryDivisionId_idx` ON `CashTransaction`(`treasuryDivisionId`);

