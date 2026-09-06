<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Database;
use App\Core\HttpException;

/**
 * Fixed-window throttle backed by MySQL. Good enough for a single-server
 * WAMP deployment; swap the storage for Redis if you scale horizontally.
 */
final class RateLimiter
{
    /**
     * Record a hit and throw 429 once the limit is exceeded.
     */
    public static function hit(string $key, int $maxAttempts, int $windowSeconds): void
    {
        $key = substr($key, 0, 190);

        // One atomic statement: increment inside a live window, reset once it
        // has rolled. Reading the row first and writing it back left a gap in
        // which two concurrent requests both saw the same count and both wrote
        // the same increment, letting a few extra attempts through.
        Database::run(
            'INSERT INTO rate_limits (bucket_key, hits, window_start) VALUES (?, 1, NOW())
             ON DUPLICATE KEY UPDATE
                hits = IF(window_start < DATE_SUB(NOW(), INTERVAL ? SECOND), 1, hits + 1),
                window_start = IF(window_start < DATE_SUB(NOW(), INTERVAL ? SECOND), NOW(), window_start)',
            [$key, $windowSeconds, $windowSeconds]
        );

        $row = Database::first(
            'SELECT hits, TIMESTAMPDIFF(SECOND, window_start, NOW()) AS elapsed
               FROM rate_limits WHERE bucket_key = ?',
            [$key]
        );

        if ($row !== null && (int) $row['hits'] > $maxAttempts) {
            throw HttpException::tooManyRequests(
                'Too many attempts. Please try again in a few minutes.',
                max(1, $windowSeconds - (int) $row['elapsed'])
            );
        }
    }

    /** Clear a bucket after a successful action (e.g. a correct login). */
    public static function clear(string $key): void
    {
        Database::run('DELETE FROM rate_limits WHERE bucket_key = ?', [substr($key, 0, 190)]);
    }

    /**
     * Housekeeping — safe to call from a cron job.
     *
     * clear() only fires on success, so every bucket that was never followed
     * by one (a failed login, an abandoned biometric challenge) would otherwise
     * sit in the table forever. A day is far longer than the longest window in
     * the API, so nothing live is ever removed.
     */
    public static function pruneStale(int $olderThanSeconds = 86400): int
    {
        return Database::affected(
            'DELETE FROM rate_limits WHERE window_start < DATE_SUB(NOW(), INTERVAL ? SECOND)',
            [$olderThanSeconds]
        );
    }
}
