-- CreateTable
CREATE TABLE `DuesPlanMember` (
    `planId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,

    INDEX `DuesPlanMember_userId_idx`(`userId`),
    PRIMARY KEY (`planId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DuesPlanMember` ADD CONSTRAINT `DuesPlanMember_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `DuesPlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DuesPlanMember` ADD CONSTRAINT `DuesPlanMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

