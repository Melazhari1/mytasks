<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Models\BudgetEntry;
use App\Models\BudgetMonth;
use App\Support\Validator;

/**
 * A monthly salary + expense log, scored against the 50/30/20 (need/want/
 * save) budgeting rule. `budget_months` holds one row per user per calendar
 * month (salary only — created lazily, see getOrCreate()); `budget_entries`
 * are the (name, price, category) lines logged against it.
 *
 * The score isn't stored — it's cheap to compute and always derived fresh
 * from the entries, so there's nothing to keep in sync. See summarize().
 */
final class BudgetController
{
    public const CATEGORIES = ['need', 'want', 'save'];

    /** The 50/30/20 rule, as fractions of salary. */
    private const STANDARD = ['need' => 0.5, 'want' => 0.3, 'save' => 0.2];

    public function indexMonths(Request $request): void
    {
        $year = $request->query('year');

        if ($year !== null && !ctype_digit($year)) {
            throw HttpException::badRequest("Invalid 'year'.");
        }

        $months = BudgetMonth::listForUser($request->userId(), $year !== null ? (int) $year : null);
        $byMonth = BudgetEntry::listForMonths(array_map(static fn (array $m) => (int) $m['id'], $months), $request->userId());

        $data = array_map(function (array $row) use ($byMonth): array {
            $entries = $byMonth[(int) $row['id']] ?? [];

            return BudgetMonth::present($row) + $this->summarize((float) $row['salary'], $entries);
        }, $months);

        Response::ok($data);
    }

    public function showMonth(Request $request): void
    {
        [$year, $month] = $this->parsePeriod($request);

        $row = BudgetMonth::findForPeriod($request->userId(), $year, $month);
        $entries = $row === null ? [] : BudgetEntry::listForMonth((int) $row['id'], $request->userId());

        Response::ok($this->presentPeriod($year, $month, $row, $entries));
    }

    /** PUT — create-or-update the salary for a period. Idempotent, so PUT (not POST) is the right verb. */
    public function setSalary(Request $request): void
    {
        [$year, $month] = $this->parsePeriod($request);

        $data = Validator::check($request->all(), ['salary' => 'required|numeric|min:0']);

        $row = BudgetMonth::upsertSalary($request->userId(), $year, $month, (float) $data['salary']);
        $entries = BudgetEntry::listForMonth((int) $row['id'], $request->userId());

        Response::ok($this->presentPeriod($year, $month, $row, $entries));
    }

    public function destroyMonth(Request $request): void
    {
        [$year, $month] = $this->parsePeriod($request);

        $row = BudgetMonth::findForPeriod($request->userId(), $year, $month);

        if ($row === null || BudgetMonth::delete((int) $row['id'], $request->userId()) === 0) {
            throw HttpException::notFound('No budget for that month.');
        }

        Response::noContent();
    }

    /** Adds an entry, creating the month row (salary 0) first if it doesn't exist yet. */
    public function storeEntry(Request $request): void
    {
        [$year, $month] = $this->parsePeriod($request);
        $userId = $request->userId();

        $data = Validator::check($request->all(), [
            'name'     => 'required|string|min:1|max:150',
            'price'    => 'required|numeric|min:0',
            'category' => 'required|string|in:' . implode(',', self::CATEGORIES),
        ]);

        $monthRow = BudgetMonth::getOrCreate($userId, $year, $month);

        $id = BudgetEntry::create($userId, (int) $monthRow['id'], $data['name'], (float) $data['price'], $data['category']);

        Response::created(BudgetEntry::present(BudgetEntry::findForUser($id, $userId) ?? []));
    }

    public function updateEntry(Request $request): void
    {
        $id     = $request->intParam('id');
        $userId = $request->userId();

        if (BudgetEntry::findForUser($id, $userId) === null) {
            throw HttpException::notFound('Entry not found.');
        }

        $data = Validator::check($request->all(), [
            'name'     => 'nullable|string|min:1|max:150',
            'price'    => 'nullable|numeric|min:0',
            'category' => 'nullable|string|in:' . implode(',', self::CATEGORIES),
        ]);

        BudgetEntry::update($id, $userId, $data);

        Response::ok(BudgetEntry::present(BudgetEntry::findForUser($id, $userId) ?? []));
    }

    public function destroyEntry(Request $request): void
    {
        if (BudgetEntry::delete($request->intParam('id'), $request->userId()) === 0) {
            throw HttpException::notFound('Entry not found.');
        }

        Response::noContent();
    }

    /** @return array{0:int,1:int} [year, month] */
    private function parsePeriod(Request $request): array
    {
        $year  = $request->intParam('year');
        $month = $request->intParam('month');

        if ($year < 2000 || $year > 2100) {
            throw HttpException::badRequest("Invalid 'year'.");
        }

        if ($month < 1 || $month > 12) {
            throw HttpException::badRequest("Invalid 'month'. Must be 1-12.");
        }

        return [$year, $month];
    }

    /**
     * @param array<string,mixed>|null $row
     * @param list<array<string,mixed>> $entries
     * @return array<string,mixed>
     */
    private function presentPeriod(int $year, int $month, ?array $row, array $entries): array
    {
        $salary = $row !== null ? (float) $row['salary'] : 0.0;

        $base = $row !== null
            ? BudgetMonth::present($row)
            : ['id' => null, 'year' => $year, 'month' => $month, 'salary' => 0.0, 'created_at' => null, 'updated_at' => null];

        return $base
            + ['entries' => array_map([BudgetEntry::class, 'present'], $entries)]
            + $this->summarize($salary, $entries);
    }

    /**
     * Compares real spending per category against the 50/30/20 targets and
     * turns the gap into a 0-5 score.
     *
     * For each category, real_pct is spend-in-that-category ÷ salary. Summing
     * |real_pct - target_pct| across need/want/save gives a single "how far
     * off the standard split are you" number: 0 is a perfect match, 1.0 is
     * as wrong as it gets without overspending (e.g. everything landed in
     * one category), higher still if salary was overspent. That deviation,
     * scaled onto 0-5 and clamped, is the score — deviation 0 -> 5/5,
     * deviation >= 1.0 -> 0/5. No salary set means no ratios to score, so
     * score comes back null rather than a misleading number.
     *
     * @param list<array<string,mixed>> $entries
     * @return array<string,mixed>
     */
    private function summarize(float $salary, array $entries): array
    {
        $totals = ['need' => 0.0, 'want' => 0.0, 'save' => 0.0];

        foreach ($entries as $entry) {
            $totals[$entry['category']] = ($totals[$entry['category']] ?? 0.0) + (float) $entry['price'];
        }

        $categories = [];
        $deviation  = 0.0;

        foreach (self::STANDARD as $key => $targetPct) {
            $targetAmount = $salary * $targetPct;
            $realAmount   = $totals[$key];
            $realPct      = $salary > 0 ? $realAmount / $salary : 0.0;

            $categories[$key] = [
                'target_pct'    => $targetPct,
                'target_amount' => round($targetAmount, 2),
                'real_amount'   => round($realAmount, 2),
                'real_pct'      => round($realPct, 4),
                'diff'          => round($realAmount - $targetAmount, 2),
            ];

            $deviation += abs($realPct - $targetPct);
        }

        $spent = array_sum($totals);
        $score = $salary > 0 ? max(0.0, min(5.0, 5.0 - $deviation * 5.0)) : null;

        return [
            'categories'  => $categories,
            'total_spent' => round($spent, 2),
            'unallocated' => round($salary - $spent, 2),
            'score'       => $score !== null ? round($score, 1) : null,
        ];
    }
}
