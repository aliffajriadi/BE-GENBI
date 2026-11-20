-- Role baru: Wakil Ketua Umum. Permission-nya disalin dari Ketum yang sedang berlaku (termasuk perubahan dari panel).
INSERT IGNORE INTO `Role` (`id`, `key`, `name`, `updatedAt`) VALUES ('role_waketum', 'WAKETUM', 'Wakil Ketua Umum', CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
  SELECT w.`id`, rp.`permissionId` FROM `Role` w
  JOIN `Role` k ON k.`key` = 'KETUM'
  JOIN `RolePermission` rp ON rp.`roleId` = k.`id`
  WHERE w.`key` = 'WAKETUM';
