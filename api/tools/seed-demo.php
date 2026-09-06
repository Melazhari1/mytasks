<?php

/**
 * Create a demo account with enough data to make the dashboard worth looking at.
 *
 *   php tools/seed-demo.php
 *   php tools/seed-demo.php --email=me@example.com --password='Str0ngPass!'
 *   php tools/seed-demo.php --fresh          # wipe this account's data and redo it
 *
 * A note on "admin": the API has no roles. Every account is an ordinary user
 * that can only ever see its own tasks and its own vault — ownership is checked
 * in the WHERE clause of every query. This script just gives you a signed-up
 * account with realistic data in it; it does not grant anything special.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script may only be run from the command line.\n");
}

define('API_ROOT', dirname(__DIR__));

require API_ROOT . '/src/Core/Autoloader.php';

use App\Core\Autoloader;
use App\Core\Database;
use App\Core\Env;
use App\Models\User;
use App\Models\VaultAccount;

Autoloader::register(API_ROOT . '/src', 'App\\');
Env::load(API_ROOT . '/.env');
date_default_timezone_set(Env::get('APP_TIMEZONE', 'UTC'));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
$options = [];

foreach (array_slice($argv, 1) as $argument) {
    if (preg_match('/^--([a-z-]+)(?:=(.*))?$/', $argument, $m)) {
        $options[$m[1]] = $m[2] ?? true;
    }
}

$email    = is_string($options['email'] ?? null) ? strtolower(trim($options['email'])) : 'admin@mytasks.local';
$password = is_string($options['password'] ?? null) ? $options['password'] : 'Admin123!';
$name     = is_string($options['name'] ?? null) ? $options['name'] : 'Admin';
$fresh    = isset($options['fresh']);

/** Fail loudly and with a non-zero status, so this is safe to script. */
function fail(string $message): never
{
    fwrite(STDERR, $message . "\n");
    exit(1);
}

if (strlen($password) < 8) {
    fail('Password must be at least 8 characters.');
}

if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
    fail("'{$email}' is not a valid email address.");
}

echo "Seeding demo data into '" . Env::get('DB_DATABASE', 'mytasks') . "'…\n\n";

try {
    Database::run('SELECT 1');
} catch (Throwable $e) {
    fail('Could not reach MySQL. Check the DB_* values in .env, and that MySQL is running.');
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
$existing = User::findByEmail($email);

if ($existing !== null && !$fresh) {
    fail(
        "An account for {$email} already exists (id {$existing['id']}).\n"
        . 'Re-run with --fresh to wipe its tasks, goals and vault and seed them again.'
    );
}

if ($existing !== null) {
    $userId = (int) $existing['id'];

    // ON DELETE CASCADE handles tasks; categories and vault entries go with it.
    Database::run('DELETE FROM categories     WHERE user_id = ?', [$userId]);
    Database::run('DELETE FROM tasks          WHERE user_id = ?', [$userId]);
    Database::run('DELETE FROM vault_accounts WHERE user_id = ?', [$userId]);

    // Reset the password too, so --fresh always lands you back at a known state.
    Database::run('UPDATE users SET password_hash = ?, name = ? WHERE id = ?', [
        User::hashPassword($password),
        $name,
        $userId,
    ]);

    echo "Reset the existing account (id {$userId}) and cleared its data.\n";
} else {
    $userId = User::create($email, $password, $name);
    echo "Created account (id {$userId}).\n";
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------
$goals = [
    'YouTube'      => ['🎬', '#8b7cf6'],
    'Finance'      => ['💰', '#22d3ee'],
    'House chores' => ['🏠', '#fbbf24'],
    'Fitness'      => ['💪', '#34d399'],
    'Learning'     => ['📚', '#f472b6'],
    'Client work'  => ['💼', '#60a5fa'],
];

$goalIds = [];

foreach ($goals as $goalName => [$icon, $color]) {
    $goalIds[$goalName] = Database::insert(
        'INSERT INTO categories (user_id, name, icon, color) VALUES (?, ?, ?, ?)',
        [$userId, $goalName, $icon, $color]
    );
}

echo 'Added ' . count($goalIds) . " goals.\n";

// ---------------------------------------------------------------------------
// Tasks
//
// [goal, title, priority, days from today (null = no date), done?, reminder mins]
// Spread across the last two weeks so the activity chart has a shape, and with
// a few overdue items so the tiles aren't all zero.
// ---------------------------------------------------------------------------
$tasks = [
    ['YouTube',      'Edit the thumbnail',         'high',   0,   false, 60],
    ['YouTube',      'Script next short',          'medium', 1,   false, null],
    ['YouTube',      'Upload weekly video',        'high',   2,   false, 1440],
    ['YouTube',      'Reply to comments',          'low',    0,   true,  null],
    ['YouTube',      'Design channel banner',      'low',    null, true, null],

    ['Finance',      'Pay invoices',               'high',   0,   false, 60],
    ['Finance',      'Chase the late payment',     'high',   -2,  false, 60],
    ['Finance',      'Reconcile bank statement',   'medium', 5,   false, null],
    ['Finance',      'Review subscriptions',       'low',    9,   false, null],
    ['Finance',      'File Q2 receipts',           'medium', null, true, null],

    ['House chores', 'Water the plants',           'low',    -1,  false, null],
    ['House chores', 'Take out recycling',         'low',    1,   false, null],
    ['House chores', 'Fix the kitchen tap',        'medium', 3,   false, null],

    ['Fitness',      'Morning run',                'medium', 0,   false, 15],
    ['Fitness',      'Gym session',                'medium', 2,   false, 30],
    ['Fitness',      'Book a physio appointment',  'low',    6,   false, null],

    ['Learning',     'Finish PHP course module',   'medium', 4,   false, 1440],
    ['Learning',     'Read chapter 7',             'low',    6,   false, null],
    ['Learning',     'Practice SQL joins',         'low',    null, true, null],

    ['Client work',  'Ship the API',               'high',   0,   false, 180],
    ['Client work',  'Client call prep',           'high',   1,   false, 60],
    ['Client work',  'Send the invoice',           'medium', 7,   false, null],
    ['Client work',  'Write handover doc',         'low',    11,  false, null],
    ['Client work',  'Set up the staging server',  'high',   -3,  false, 60],
    ['Client work',  'Kick-off meeting notes',     'medium', null, true, null],
];

/* Tasks that repeat rather than close when completed. */
$recurring = [
    'Morning run'        => 'daily',
    'Reply to comments'  => 'daily',
    'Take out recycling' => 'weekly',
    'Gym session'        => 'weekly',
];

$times = ['09:00', '11:30', '14:00', '17:45', '20:15'];

/**
 * How many days ago each task was created, one entry per task above.
 *
 * Hand-written rather than computed: any arithmetic pattern spreads tasks
 * evenly and the activity chart comes out as a machine-perfect zigzag, which
 * reads as fake at a glance. This has busy days, quiet days and one day with
 * nothing at all — the shape real usage has. Fixed, not random, so re-seeding
 * gives you the same chart to compare against.
 */
$createdDaysAgo = [13, 12, 12, 11, 9, 9, 9, 8, 7, 7, 6, 6, 6, 5, 4, 3, 3, 2, 2, 2, 1, 1, 0, 0, 0];

$made = 0;

foreach ($tasks as $index => [$goal, $title, $priority, $dayOffset, $done, $notify]) {
    $repeat  = $recurring[$title] ?? null;
    $created = $createdDaysAgo[$index] ?? 7;
    $due = $dayOffset === null
        ? null
        : (new DateTimeImmutable("today {$times[$index % 5]}"))->modify(($dayOffset >= 0 ? '+' : '') . $dayOffset . ' days');

    // A completed task must have been completed after it was created, never before.
    $completedAt = $done
        ? (new DateTimeImmutable())->modify('-' . min($created, ($index * 3) % 12) . ' days')->format('Y-m-d H:i:s')
        : null;

    Database::insert(
        'INSERT INTO tasks
            (user_id, category_id, title, priority, is_recurring, recurring_type,
             due_date, notify_before_minutes, status, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))',
        [
            $userId,
            $goalIds[$goal],
            $title,
            $priority,
            $repeat !== null ? 1 : 0,
            $repeat,
            $due?->format('Y-m-d H:i:s'),
            $notify,
            $done ? 'completed' : 'pending',
            $completedAt,
            $created,
        ]
    );

    $made++;
}

echo "Added {$made} tasks (some overdue, some done, four recurring).\n";

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------
$credentials = [
    ['GitHub',      'melazhari',              'gh_pat_9xQ2v!Kd7m',  'https://github.com',     'Work account, 2FA on'],
    ['AWS Console', 'root@mytasks',           'aWs-R00t-K3y!x9Lp',  'https://aws.amazon.com', 'Billing alerts enabled'],
    ['Netflix',     'demo@mytasks.local',     'W4tchM0re!2026',     'https://netflix.com',    null],
    ['Figma',       'melazhari',              'd3sign-Th1ngs!42',   'https://figma.com',      null],
    ['cPanel',      'mytasks_admin',          'h0st-P4nel!secure',  null,                     'Shared hosting control panel'],
];

foreach ($credentials as [$platform, $username, $secret, $url, $note]) {
    VaultAccount::create($userId, $platform, $username, $secret, $note, $url);
}

echo 'Added ' . count($credentials) . " vault entries (encrypted with APP_KEY).\n";

// ---------------------------------------------------------------------------
// What to do next
// ---------------------------------------------------------------------------
$twoFactorOn = Env::bool('TWO_FACTOR_REQUIRED', true);
$mailDriver  = strtolower((string) Env::get('MAIL_DRIVER', 'log'));

echo "\n";
echo "──────────────────────────────────────────────────────────\n";
echo "  Sign in at:  " . rtrim((string) Env::get('APP_URL', 'http://localhost/xxp/mytasks/api'), '/') . "\n";
echo "               (the web client is the sibling /web folder)\n\n";
echo "  Email:       {$email}\n";
echo "  Password:    {$password}\n";
echo "──────────────────────────────────────────────────────────\n\n";

if ($twoFactorOn) {
    echo "Two-factor is ON, so sign-in has a second step.\n";

    if ($mailDriver === 'log') {
        echo "MAIL_DRIVER=log means the code is not actually emailed — after you\n";
        echo "submit the password, read the 6-digit code from the bottom of:\n\n";
        echo "    " . API_ROOT . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . "mail.log\n\n";
        echo "The sign-in screen says the same thing while APP_DEBUG=true.\n\n";
    }

    echo "To skip the second step while you are just looking around, set\n";
    echo "TWO_FACTOR_REQUIRED=false in .env. Turn it back on before this is\n";
    echo "reachable by anyone else — a vault behind one password is not a vault.\n";
} else {
    echo "TWO_FACTOR_REQUIRED=false, so the password alone signs you straight in.\n";
    echo "Turn it back on before this is reachable by anyone else.\n";
}

echo "\nDone.\n";
