<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;

final class BudgetMonth
{
    /** @return list<array<string,mixed>> */
    public static function listForUser(int $userId, ?int $year = null): array
    {
        $where    = ['user_id = ?'];
        $bindings = [$userId];

        if ($year !== null) {
            $where[]    = 'year = ?';
            $bindings[] = $year;
        }

        return Database::all(
            'SELECT * FROM budget_months WHERE ' . implode(' AND ', $where) . ' ORDER BY year DESC, month DESC',
            $bindings
        );
    }

    /** @return array<string,mixed>|null */
    public static function findForUser(int $id, int $userId): ?array
    {
        return Database::first('SELECT * FROM budget_months WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /** @return array<string,mixed>|null */
    public static function findForPeriod(int $userId, int $year, int $month): ?array
    {
        return Database::first(
            'SELECT * FROM budget_months WHERE user_id = ? AND year = ? AND month = ?',
            [$userId, $year, $month]
        );
    }

    /** Creates the month row with salary 0 if it doesn't exist yet — used so entries can be logged before a salary is set. */
    public static function getOrCreate(int $userId, int $year, int $month): array
    {
        $existing = self::findForPeriod($userId, $year, $month);

        if ($existing !== null) {
            return $existing;
        }

        Database::insert(
            'INSERT INTO budget_months (user_id, year, month, salary) VALUES (?, ?, ?, 0)',
            [$userId, $year, $month]
        );

        // Not lastInsertId() — see upsertSalary() for why this looks up fresh instead.
        return self::findForPeriod($userId, $year, $month) ?? [];
    }

    /** @return array<string,mixed> the month row after the upsert */
    public static function upsertSalary(int $userId, int $year, int $month, float $salary): array
    {
        Database::run(
            'INSERT INTO budget_months (user_id, year, month, salary) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE salary = VALUES(salary)',
            [$userId, $year, $month, $salary]
        );

        // lastInsertId() is unreliable on the UPDATE branch of an upsert (MySQL
        // only updates it there if the SET clause explicitly re-touches the
        // auto-increment column), so re-fetch by the real unique key instead.
        return self::findForPeriod($userId, $year, $month) ?? [];
    }

    public static function delete(int $id, int $userId): int
    {
        return Database::affected('DELETE FROM budget_months WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function present(array $row): array
    {
        return [
            'id'         => (int) $row['id'],
            'year'       => (int) $row['year'],
            'month'      => (int) $row['month'],
            'salary'     => (float) $row['salary'],
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }
}
