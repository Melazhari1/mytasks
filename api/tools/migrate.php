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

/**
 * Split a migration file into individual statements.
 *
 * The connection runs with PDO::ATTR_EMULATE_PREPARES => false, so query()
 * goes through a native prepared statement -- and those accept exactly one
 * statement. exec() would take a whole batch, but then any result set in it
 * (a SELECT, a CALL, an EXECUTE) is left unconsumed and the next query dies
 * with "Cannot execute queries while other unbuffered queries are active".
 * Splitting here and running one statement at a time avoids both.
 *
 * The scanner tracks quotes, backticks and comments so a semicolon inside a
 * string literal or a comment does not split the statement. It deliberately
 * does not try to understand BEGIN/END blocks: DELIMITER is a directive the
 * mysql *client* implements and the server never sees, so a stored-procedure
 * body cannot be sent over PDO at all. Write migrations as plain statements.
 *
 * @return list<string>
 */
function splitStatements(string $sql): array
{
    $statements = [];
    $buffer     = '';
    $length     = strlen($sql);
    $quote      = null;      // ' " or `
    $comment    = null;      // 'line' or 'block'

    for ($i = 0; $i < $length; $i++) {
        $char = $sql[$i];
        $next = $i + 1 < $length ? $sql[$i + 1] : '';

        if ($comment === 'line') {
            if ($char === "\n") {
                $comment = null;
                $buffer .= $char;
            }

            continue;
        }

        if ($comment === 'block') {
            if ($char === '*' && $next === '/') {
                $comment = null;
                $i++;
            }

            continue;
        }

        if ($quote !== null) {
            $buffer .= $char;

            if ($char === '\\' && $quote !== '`') {
                // Escaped character inside a string -- take the next one too.
                if ($next !== '') {
                    $buffer .= $next;
                    $i++;
                }

                continue;
            }

            if ($char === $quote) {
                $quote = null;
            }

            continue;
        }

        if ($char === '-' && $next === '-' && ($i + 2 >= $length || $sql[$i + 2] === ' ' || $sql[$i + 2] === "\t" || $sql[$i + 2] === "\n" || $sql[$i + 2] === "\r")) {
            $comment = 'line';
            $i++;

            continue;
        }

        if ($char === '#') {
            $comment = 'line';

            continue;
        }

        if ($char === '/' && $next === '*') {
            $comment = 'block';
            $i++;

            continue;
        }

        if ($char === "'" || $char === '"' || $char === '`') {
            $quote = $char;
            $buffer .= $char;

            continue;
        }

        if ($char === ';') {
            if (trim($buffer) !== '') {
                $statements[] = trim($buffer);
            }

            $buffer = '';

            continue;
        }

        $buffer .= $char;
    }

    if (trim($buffer) !== '') {
        $statements[] = trim($buffer);
    }

    return $statements;
}

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
        $statements = splitStatements($sql);

        Database::transaction(static function () use ($statements, $name): void {
            $pdo = Database::connection();

            foreach ($statements as $statement) {
                // Every result set is consumed before the next statement runs.
                $result = $pdo->query($statement);

                if ($result !== false) {
                    $result->fetchAll();
                    $result->closeCursor();
                }
            }

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
