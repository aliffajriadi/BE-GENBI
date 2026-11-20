-- CreateTable
CREATE TABLE `Signature` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `purpose` TEXT NULL,
    `signerTitle` VARCHAR(191) NOT NULL,
    `signedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `signerId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Signature_code_key`(`code`),
    INDEX `Signature_signerId_createdAt_idx`(`signerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Signature` ADD CONSTRAINT `Signature_signerId_fkey` FOREIGN KEY (`signerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Permission baru + default untuk role petinggi (SYS_ADMIN, KETUM, SEKRETARIS, BENDAHARA). Bisa diubah dari Pengaturan > Role.
INSERT IGNORE INTO `Permission` (`id`, `key`, `label`, `updatedAt`) VALUES ('perm_signature_create', 'signature.create', 'Buat tanda tangan elektronik (QR)', CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
  SELECT r.`id`, p.`id` FROM `Role` r JOIN `Permission` p ON p.`key` = 'signature.create'
  WHERE r.`key` IN ('SYS_ADMIN', 'KETUM', 'SEKRETARIS', 'BENDAHARA');
