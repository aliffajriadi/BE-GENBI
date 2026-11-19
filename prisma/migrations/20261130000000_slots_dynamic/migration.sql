-- Slot jadi umum (kelompok, undangan, sesi): label bisa diatur, pertanyaan wajib, kuota boleh tanpa batas.
ALTER TABLE `SlotList` ADD COLUMN `optionNoun` VARCHAR(191) NOT NULL DEFAULT 'Kelompok',
    ADD COLUMN `joinLabel` VARCHAR(191) NOT NULL DEFAULT 'Gabung',
    ADD COLUMN `questions` JSON NULL;

ALTER TABLE `SlotGroup` ADD COLUMN `description` VARCHAR(191) NULL,
    MODIFY `capacity` INTEGER NULL;

ALTER TABLE `SlotEntry` ADD COLUMN `answers` JSON NULL;
