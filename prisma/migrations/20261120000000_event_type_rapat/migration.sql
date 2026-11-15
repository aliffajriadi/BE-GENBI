-- Rapat pleno + rapat divisi digabung jadi satu jenis: RAPAT.
ALTER TABLE `Event` MODIFY `type` ENUM('RAPAT_PLENO', 'RAPAT_DIVISI', 'RAPAT', 'KEGIATAN', 'KEPANITIAAN') NOT NULL;
UPDATE `Event` SET `type` = 'RAPAT' WHERE `type` IN ('RAPAT_PLENO', 'RAPAT_DIVISI');
ALTER TABLE `Event` MODIFY `type` ENUM('RAPAT', 'KEGIATAN', 'KEPANITIAAN') NOT NULL;
