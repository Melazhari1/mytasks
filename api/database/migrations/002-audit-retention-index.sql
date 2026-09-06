-- tools/reminders.php now prunes audit_logs on a retention window
-- (AUDIT_RETENTION_DAYS). That DELETE filters on created_at, so it needs
-- idx_audit_created to stay cheap as the table grows.
--
-- The baseline schema already declares that index, so this is a no-op on any
-- database built from schema.sql. It exists for one built before the index
-- was added.
--
-- MySQL has no CREATE INDEX IF NOT EXISTS, and a stored procedure is not an
-- option here: its BEGIN/END body needs a DELIMITER change, which is a
-- directive the mysql *client* understands and the server never sees -- so it
-- cannot survive being sent over PDO. A prepared statement built from a
-- lookup does the same job in plain, single statements.

SET @index_exists := (
    SELECT COUNT(*)
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name   = 'audit_logs'
       AND index_name   = 'idx_audit_created'
);

SET @ddl := IF(
    @index_exists = 0,
    'CREATE INDEX idx_audit_created ON audit_logs (created_at)',
    'DO 1'
);

PREPARE apply_index FROM @ddl;
EXECUTE apply_index;
DEALLOCATE PREPARE apply_index;
