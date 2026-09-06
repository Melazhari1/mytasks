-- The audit trail is now pruned by tools/reminders.php on a retention window
-- (AUDIT_RETENTION_DAYS). idx_audit_created already exists in the baseline
-- schema and is what makes that DELETE cheap; this migration exists so an
-- older database that predates it still gets one.
--
-- Wrapped in a stored procedure because MySQL has no CREATE INDEX IF NOT
-- EXISTS, and a duplicate-index error would abort the whole run.
DROP PROCEDURE IF EXISTS mytasks_add_audit_index;

CREATE PROCEDURE mytasks_add_audit_index()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.statistics
         WHERE table_schema = DATABASE()
           AND table_name   = 'audit_logs'
           AND index_name   = 'idx_audit_created'
    ) THEN
        CREATE INDEX idx_audit_created ON audit_logs (created_at);
    END IF;
END;

CALL mytasks_add_audit_index();
DROP PROCEDURE mytasks_add_audit_index;
