-- Kadiv juga bisa membuat tanda tangan elektronik (dan mendelegasikannya ke anggota divisi lewat Kelola divisi).
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
  SELECT r.`id`, p.`id` FROM `Role` r JOIN `Permission` p ON p.`key` = 'signature.create'
  WHERE r.`key` = 'KADIV';
