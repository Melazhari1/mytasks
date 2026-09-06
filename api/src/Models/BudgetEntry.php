<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;

final class BudgetEntry
{
    /** @return list<array<string,mixed>> */
    public static function listForMonth(int $budgetMonthId, int $userId): array
    {
        return Database::all(
            'SELECT * FROM budget_entries WHERE budget_month_id = ? AND user_id = ? ORDER BY id ASC',
            [$budgetMonthId, $userId]
        );
    }

    /**
     * All entries across several months in one query — avoids N+1 when
     * BudgetController builds the score for every month in a listing.
     *
     * @param list<int> $monthIds
     * @return array<int,list<array<string,mixed>>> keyed by budget_month_id
     */
    public static function listForMonths(array $monthIds, int $userId): array
    {
        if ($monthIds === []) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($monthIds), '?'));

        $rows = Database::all(
            "SELECT * FROM budget_entries WHERE user_id = ? AND budget_month_id IN ({$placeholders}) ORDER BY id ASC",
            [$userId, ...$monthIds]
        );

        $byMonth = [];

        foreach ($rows as $row) {
            $byMonth[(int) $row['budget_month_id']][] = $row;
        }

        return $byMonth;
    }

    /** @return array<string,mixed>|null */
    public static function findForUser(int $id, int $userId): ?array
    {
        return Database::first('SELECT * FROM budget_entries WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    public static function create(int $userId, int $budgetMonthId, string $name, float $price, string $category): int
    {
        return Database::insert(
            'INSERT INTO budget_entries (user_id, budget_month_id, name, price, category) VALUES (?, ?, ?, ?, ?)',
            [$userId, $budgetMonthId, $name, $price, $category]
        );
    }

    /** @param array<string,mixed> $fields */
    public static function update(int $id, int $userId, array $fields): void
    {
        $allowed  = ['name', 'price', 'category'];
        $sets     = [];
        $bindings = [];

        foreach ($fields as $column => $value) {
            if (!in_array($column, $allowed, true)) {
                continue;
            }

            $sets[]     = "`{$column}` = ?";
            $bindings[] = $value;
        }

        if ($sets === []) {
            return;
        }

        $bindings[] = $id;
        $bindings[] = $userId;

        Database::run(
            'UPDATE budget_entries SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?',
            $bindings
        );
    }

    public static function delete(int $id, int $userId): int
    {
        return Database::affected('DELETE FROM budget_entries WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function present(array $row): array
    {
        return [
            'id'              => (int) $row['id'],
            'budget_month_id' => (int) $row['budget_month_id'],
            'name'            => $row['name'],
            'price'           => (float) $row['price'],
            'category'        => $row['category'],
            'created_at'      => $row['created_at'] ?? null,
            'updated_at'      => $row['updated_at'] ?? null,
        ];
    }
}
