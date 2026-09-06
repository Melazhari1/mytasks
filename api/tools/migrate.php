<?php

/**
 * Migration runner.
 *
 *   php tools/migrate.php            apply everything not yet applied
 *   php tools/migrate.php --status   list what is applied and what is pending
 *   php tools/migrate.php --pretend  print the plan without touching anything
 *
 * schema.sql builds a fresh database and can never alter an existing one, so
 * every change after the baseline lives here instead:
 *
 *   database/migrations/NNN-short-description.sql
 *
 * Files run in filename order, once each, inside a transaction where the
 * statements allow it. What has run is recorded in `schema_migrations`, so a
 * second run is a no-op and two machines can't drift.
 *
 * DDL in MySQL commits implicitly, so a file that mixes DDL and DML cannot be
 * rolled back as a unit -- keep one concern per file and the runner's
 * transaction is enough.
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

Autoloader::register(API_ROOT . '/src', 'App\\');
Env::load(API_ROOT . '/.env');

$options = getopt('', ['status', 'pretend']);
$status  = array_key_exists('status', $options);
$pretend = array_key_exists('pretend', $options);

$dir = API_ROOT . '/database/migrations';

if (!is_dir($dir)) {
    exit("No database/migrations folder found.\n");
}

Database::run(
    'CREATE TABLE IF NOT EXISTS `schema_migrations` (
        `migration`  VARCHAR(190) NOT NULL,
        `applied_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (`migration`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
);

$applied = array_column(Database::all('SELECT migration FROM schema_migrations'), 'migration');
$files   = glob($dir . '/*.sql') ?: [];
sort($files, SORT_STRING);

$pending = [];

foreach ($files as $file) {
    $name = basename($file);

    if (!in_array($name, $applied, true)) {
        $pending[] = $file;
    }
}

if ($status) {
    echo "\nApplied (" . count($applied) . ")\n";

    foreach ($applied as $name) {
        echo "  [x] {$name}\n";
    }

    echo "\nPending (" . count($pending) . ")\n";

    foreach ($pending as $file) {
        echo "  [ ] " . basename($file) . "\n";
    }

    echo "\n";
    exit(0);
}

if ($pending === []) {
    echo "Nothing to migrate -- " . count($applied) . " migration(s) already applied.\n";
    exit(0);
}

echo "\n" . ($pretend ? 'Would apply' : 'Applying') . ' ' . count($pending) . " migration(s)\n\n";

foreach ($pending as $file) {
    $name = basename($file);
    echo "  {$name} ... ";

    if ($pretend) {
        echo "skipped (--pretend)\n";
        continue;
    }

    $sql = (string) file_get_contents($file);

    try {
        Database::transaction(static function () use ($sql, $name): void {
            $pdo = Database::connection();

            // exec() runs the whole file, semicolons and all. Stored procedures
            // in the migrations use BEGIN/END blocks, which a naive split on
            // ';' would cut in half.
            $pdo->exec($sql);

            Database::run('INSERT INTO schema_migrations (migration) VALUES (?)', [$name]);
        });

        echo "ok\n";
    } catch (\Throwable $e) {
        echo "FAILED\n\n";
        echo "  {$e->getMessage()}\n\n";
        echo "  Nothing after this file was applied. Fix it and re-run.\n\n";
        exit(1);
    }
}

echo "\nDone.\n\n";
