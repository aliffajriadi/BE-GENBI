-- PIC kartu planning bisa lebih dari satu: assigneeId -> tabel relasi _CardAssignees.

-- CreateTable
CREATE TABLE `_CardAssignees` (
    `A` VARCHAR(191) NOT NULL,
    `B` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `_CardAssignees_AB_unique`(`A`, `B`),
    INDEX `_CardAssignees_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Pindahkan PIC lama.
INSERT INTO `_CardAssignees` (`A`, `B`) SELECT `id`, `assigneeId` FROM `BoardCard` WHERE `assigneeId` IS NOT NULL;

-- DropForeignKey
ALTER TABLE `BoardCard` DROP FOREIGN KEY `BoardCard_assigneeId_fkey`;

-- AlterTable
ALTER TABLE `BoardCard` DROP COLUMN `assigneeId`;

-- AddForeignKey
ALTER TABLE `_CardAssignees` ADD CONSTRAINT `_CardAssignees_A_fkey` FOREIGN KEY (`A`) REFERENCES `BoardCard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_CardAssignees` ADD CONSTRAINT `_CardAssignees_B_fkey` FOREIGN KEY (`B`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
