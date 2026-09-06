<?php

declare(strict_types=1);

namespace App\Core;

use PDO;
use PDOException;

/**
 * Lazy singleton PDO connection. Every query in the app goes through here
 * with bound parameters — no string interpolation into SQL, anywhere.
 */
final class Database
{
    private static ?PDO $pdo = null;

    public static function connection(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $host    = Env::get('DB_HOST', '127.0.0.1');
        $port    = Env::int('DB_PORT', 3306);
        $name    = Env::get('DB_DATABASE', 'mytasks');
        $charset = Env::get('DB_CHARSET', 'utf8mb4');

        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset={$charset}";

        try {
            self::$pdo = new PDO(
                $dsn,
                Env::get('DB_USERNAME', 'root'),
                Env::get('DB_PASSWORD', ''),
                [
                    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES   => false,
                    PDO::ATTR_STRINGIFY_FETCHES  => false,
                ]
            );
        } catch (PDOException $e) {
            error_log('[db] connection failed: ' . $e->getMessage());

            throw new HttpException(503, 'database_unavailable', 'Could not connect to the database.');
        }

        self::alignTimezone(self::$pdo);

        return self::$pdo;
    }

    /**
     * Pin the MySQL session to PHP's timezone.
     *
     * Without this, NOW() runs on the server's clock while PHP's time() and
     * strtotime() run on APP_TIMEZONE. Every expiry check that compares a
     * MySQL-generated timestamp against a PHP-generated one — OTP codes,
     * refresh tokens, account lockouts, rate-limit windows — is then wrong by
     * the offset between them.
     */
    private static function alignTimezone(PDO $pdo): void
    {
        $offset = (new \DateTimeImmutable('now', new \DateTimeZone(Env::get('APP_TIMEZONE', 'UTC') ?? 'UTC')))
            ->format('P'); // e.g. +01:00

        try {
            $pdo->exec("SET time_zone = '{$offset}'");
        } catch (PDOException $e) {
            error_log('[db] could not set session time_zone: ' . $e->getMessage());
        }
    }

    /** @param array<string|int,mixed> $bindings */
    public static function run(string $sql, array $bindings = []): \PDOStatement
    {
        $statement = self::connection()->prepare($sql);
        $statement->execute($bindings);

        return $statement;
    }

    /**
     * @param array<string|int,mixed> $bindings
     * @return array<string,mixed>|null
     */
    public static function first(string $sql, array $bindings = []): ?array
    {
        $row = self::run($sql, $bindings)->fetch();

        return $row === false ? null : $row;
    }

    /**
     * @param array<string|int,mixed> $bindings
     * @return list<array<string,mixed>>
     */
    public static function all(string $sql, array $bindings = []): array
    {
        return self::run($sql, $bindings)->fetchAll();
    }

    /** @param array<string|int,mixed> $bindings */
    public static function insert(string $sql, array $bindings = []): int
    {
        self::run($sql, $bindings);

        return (int) self::connection()->lastInsertId();
    }

    /** @param array<string|int,mixed> $bindings */
    public static function affected(string $sql, array $bindings = []): int
    {
        return self::run($sql, $bindings)->rowCount();
    }

    public static function transaction(callable $callback): mixed
    {
        $pdo = self::connection();
        $pdo->beginTransaction();

        try {
            $result = $callback($pdo);
            $pdo->commit();

            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            throw $e;
        }
    }
}
