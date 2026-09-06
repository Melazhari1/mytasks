<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Database;
use App\Core\Env;
use App\Core\Request;

/**
 * Append-only security trail. Never fails a request — if the write blows up
 * (table missing, disk full), it is logged and swallowed.
 */
final class Audit
{
    public static function record(?int $userId, string $action, ?string $subject = null, ?Request $request = null): void
    {
        try {
            Database::run(
                'INSERT INTO audit_logs (user_id, action, subject, ip_address, user_agent)
                 VALUES (?, ?, ?, ?, ?)',
                [
                    $userId,
                    $action,
                    $subject,
                    $request?->ip() ?? ($_SERVER['REMOTE_ADDR'] ?? null),
                    $request?->userAgent() ?? substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
                ]
            );
        } catch (\Throwable $e) {
            error_log('[audit] ' . $e->getMessage());
        }
    }

    /**
     * Housekeeping — safe to call from a cron job.
     *
     * The trail is append-only and nothing else ever deletes from it, so it
     * grows without bound. A retention window keeps it useful (the point of an
     * audit log is the recent past) without letting it become the largest
     * table in the database. Set AUDIT_RETENTION_DAYS=0 to keep everything.
     */
    public static function prune(?int $days = null): int
    {
        $days ??= Env::int('AUDIT_RETENTION_DAYS', 365);

        if ($days <= 0) {
            return 0;
        }

        return Database::affected(
            'DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
            [$days]
        );
    }
}
