-- CreateTable
CREATE TABLE `DivisionGrant` (
    `id` VARCHAR(191) NOT NULL,
    `divisionId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `area` VARCHAR(191) NOT NULL,
    `grantedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DivisionGrant_divisionId_userId_area_key`(`divisionId`, `userId`, `area`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DivisionGrant` ADD CONSTRAINT `DivisionGrant_divisionId_fkey` FOREIGN KEY (`divisionId`) REFERENCES `Division`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DivisionGrant` ADD CONSTRAINT `DivisionGrant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

