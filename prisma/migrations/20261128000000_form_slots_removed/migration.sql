-- Mode slot dipindah ke modul Slot tersendiri; kolom slot di Form dibuang.
ALTER TABLE `Form` DROP COLUMN `capacity`, DROP COLUMN `showRoster`;
ALTER TABLE `FormResponse` DROP COLUMN `guestName`, DROP COLUMN `cancelToken`;
