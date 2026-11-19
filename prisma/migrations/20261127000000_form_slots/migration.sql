-- Mode slot: kuota pendaftar + daftar nama + batal ikut.
ALTER TABLE `Form` ADD COLUMN `capacity` INTEGER NULL,
    ADD COLUMN `showRoster` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `FormResponse` ADD COLUMN `guestName` VARCHAR(191) NULL,
    ADD COLUMN `cancelToken` VARCHAR(191) NULL;
