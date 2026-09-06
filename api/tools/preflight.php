<?php

/**
 * Deployment preflight.
 *
 *   php tools/preflight.php              check this machine
 *   php tools/preflight.php --production apply the stricter production rules
 *   php tools/preflight.php --url=https://example.com/api   also probe over HTTP
 *
 * selftest.php proves the crypto works. smoketest.php proves the routes work.
 * This proves the *server* is fit to run them: right PHP, right extensions,
 * writable storage, secrets set, debug off, secrets not web-reachable.
 *
 * Exit code is 0 only when nothing FAILED. Warnings do not fail the run --
 * they are things that are fine locally and wrong in production, which is
 * exactly what --production promotes to failures.
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

$options    = getopt('', ['production', 'url::']);
$production = array_key_exists('production', $options);
$probeUrl   = isset($options['url']) ? rtrim((string) $options['url'], '/') : null;

$pass = 0;
$warn = 0;
$fail = 0;

function good(string $label, string $detail = ''): void
{
    global $pass;
    $pass++;
    echo "  \033[32m[ ok ]\033[0m {$label}" . ($detail !== '' ? "  ({$detail})" : '') . "\n";
}

function soft(string $label, string $fix): void
{
    global $warn, $production, $fail;

    if ($production) {
        $fail++;
        echo "  \033[31m[FAIL]\033[0m {$label}\n         -> {$fix}\n";

        return;
    }

    $warn++;
    echo "  \033[33m[warn]\033[0m {$label}\n         -> {$fix}\n";
}

function hard(string $label, string $fix): void
{
    global $fail;
    $fail++;
    echo "  \033[31m[FAIL]\033[0m {$label}\n         -> {$fix}\n";
}

function section(string $title): void
{
    echo "\n{$title}\n";
}

echo "\nMyTasks preflight" . ($production ? '  --  PRODUCTION rules' : '  --  development rules') . "\n";
echo str_repeat('=', 64) . "\n";

// ---------------------------------------------------------------------------
section('Runtime');

if (PHP_VERSION_ID >= 80100) {
    good('PHP version', PHP_VERSION);
} else {
    hard('PHP ' . PHP_VERSION . ' is too old', 'This app needs PHP 8.1 or newer.');
}

foreach (['pdo_mysql', 'openssl', 'mbstring', 'json'] as $ext) {
    if (extension_loaded($ext)) {
        good("extension {$ext}");
    } else {
        hard("extension {$ext} is missing", "Enable it in php.ini, then restart the web server.");
    }
}

foreach (['zip' => 'backups', 'curl' => 'Google Drive upload and the smoke test'] as $ext => $why) {
    if (extension_loaded($ext)) {
        good("extension {$ext}");
    } else {
        soft("extension {$ext} is missing", "Optional -- needed for {$why}.");
    }
}

if (function_exists('proc_open')) {
    good('proc_open available', 'Piper text-to-speech can run');
} else {
    soft('proc_open is disabled', 'Optional -- /voice/speak will always 503. Usually disable_functions in php.ini.');
}

// ---------------------------------------------------------------------------
section('Configuration');

if (!is_file(API_ROOT . '/.env')) {
    hard('.env is missing', 'Run: php tools/keygen.php --write');
    echo "\nCannot continue without .env.\n\n";
    exit(1);
}

Env::load(API_ROOT . '/.env');
good('.env loaded');

foreach (['APP_KEY' => 32, 'JWT_SECRET' => 32] as $key => $minLength) {
    $value = (string) Env::get($key, '');

    if ($value === '') {
        hard("{$key} is empty", 'Run: php tools/keygen.php --write');
    } elseif (strlen($value) < $minLength) {
        hard("{$key} is only " . strlen($value) . " characters", "Regenerate it -- at least {$minLength}.");
    } else {
        good($key . ' set', strlen($value) . ' chars');
    }
}

if (Env::bool('APP_DEBUG', false)) {
    soft('APP_DEBUG is true', 'Set APP_DEBUG=false -- it puts exception messages and stack traces in HTTP responses.');
} else {
    good('APP_DEBUG is false');
}

if (Env::get('APP_ENV', 'local') === 'production') {
    good('APP_ENV is production');
} else {
    soft('APP_ENV is ' . Env::get('APP_ENV', 'local'), 'Set APP_ENV=production.');
}

$timezone = (string) Env::get('APP_TIMEZONE', '');
if ($timezone !== '' && in_array($timezone, timezone_identifiers_list(), true)) {
    good('APP_TIMEZONE valid', $timezone);

    // Adopt it, exactly as index.php does. Without this the clock comparison
    // further down reads MySQL's naive datetime string in php.ini's default
    // zone instead of the app's, and reports the difference between those two
    // zones as clock drift that does not exist.
    date_default_timezone_set($timezone);
} else {
    hard('APP_TIMEZONE is missing or not a real zone', 'Every expiry check compares PHP time against MySQL NOW(). Set a real identifier, e.g. Africa/Casablanca.');
}

$origins = array_filter(array_map('trim', explode(',', (string) Env::get('CORS_ALLOWED_ORIGINS', ''))));

if (in_array('*', $origins, true)) {
    soft('CORS_ALLOWED_ORIGINS contains *', 'List your real client origins instead, e.g. https://tasks.example.com');
} elseif ($origins === []) {
    good('CORS_ALLOWED_ORIGINS empty', 'same-origin only -- the safest setting');
} else {
    good('CORS_ALLOWED_ORIGINS listed', implode(', ', $origins));
}

$sameSite = strtolower((string) Env::get('REFRESH_COOKIE_SAMESITE', 'Lax'));
$secure   = Env::bool('REFRESH_COOKIE_SECURE', false);

if ($sameSite === 'none' && !$secure) {
    hard('REFRESH_COOKIE_SAMESITE=None without REFRESH_COOKIE_SECURE=true', 'Browsers reject that combination outright -- every session will die silently. Set REFRESH_COOKIE_SECURE=true.');
} else {
    good('refresh cookie flags', "SameSite={$sameSite}, Secure=" . ($secure ? 'true' : 'auto'));
}

if (!$secure) {
    soft('REFRESH_COOKIE_SECURE is not forced on', 'On HTTPS it is now detected per request, but setting it true is the explicit guarantee.');
}

if (Env::get('MAIL_DRIVER', 'log') === 'log') {
    soft('MAIL_DRIVER is log', 'OTP codes are written to storage/logs/mail.log instead of being emailed. Nobody but you can sign in.');
} else {
    good('MAIL_DRIVER is ' . Env::get('MAIL_DRIVER'));
}

if (!Env::bool('TWO_FACTOR_REQUIRED', true)) {
    soft('TWO_FACTOR_REQUIRED is false', 'Turn it back on before anyone else can reach the app.');
} else {
    good('TWO_FACTOR_REQUIRED is true');
}

if (Env::get('DB_USERNAME', 'root') === 'root') {
    soft('Database user is root', 'Create a user with rights on this schema only -- see DEPLOYMENT.md.');
} else {
    good('Database user is not root', (string) Env::get('DB_USERNAME'));
}

if ((string) Env::get('DB_PASSWORD', '') === '') {
    soft('Database password is empty', 'Fine on a local WAMP box, never on a server.');
} else {
    good('Database password set');
}

$backupKey = (string) Env::get('BACKUP_KEY', '');
if ($backupKey === '') {
    good('BACKUP_KEY empty', '/backup routes disabled -- the safest setting');
} elseif (strlen($backupKey) < 24) {
    soft('BACKUP_KEY is short', 'It gates every user\'s data. Use 32+ random characters, or leave it blank to disable the routes.');
} else {
    good('BACKUP_KEY set', strlen($backupKey) . ' chars');
}

if ((string) Env::get('BACKUP_ZIP_PASSWORD', '') === '' && $backupKey !== '') {
    soft('BACKUP_ZIP_PASSWORD is empty', 'Backups contain .env -- APP_KEY, JWT_SECRET, the DB password. Set a passphrase.');
}

// ---------------------------------------------------------------------------
section('Filesystem');

foreach (['storage/logs', 'storage/backups'] as $dir) {
    $path = API_ROOT . '/' . $dir;

    if (!is_dir($path)) {
        hard("{$dir} does not exist", "mkdir -p {$path}");
    } elseif (!is_writable($path)) {
        hard("{$dir} is not writable", "chown it to the web-server user, e.g. chown -R www-data:www-data {$path}");
    } else {
        good("{$dir} writable");
    }
}

foreach (['src', 'routes', 'database', 'storage', 'tools'] as $dir) {
    if (is_file(API_ROOT . '/' . $dir . '/.htaccess')) {
        good("{$dir}/.htaccess guard present");
    } else {
        hard("{$dir}/.htaccess is missing", "That folder is only protected by a path pattern now. Restore the deny guard.");
    }
}

// Windows is case-insensitive, Linux is not: a class whose file name differs
// from the class name works locally and 500s on the server.
$mismatched = [];
$iterator   = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(API_ROOT . '/src'));

foreach ($iterator as $file) {
    if (!$file instanceof SplFileInfo || $file->getExtension() !== 'php') {
        continue;
    }

    $source = (string) file_get_contents($file->getPathname());

    if (preg_match('/^\s*(?:final |abstract )?class\s+(\w+)/m', $source, $m) === 1) {
        if ($m[1] !== $file->getBasename('.php')) {
            $mismatched[] = $file->getBasename() . ' declares class ' . $m[1];
        }
    }
}

if ($mismatched === []) {
    good('class names match file names', 'safe on a case-sensitive filesystem');
} else {
    foreach ($mismatched as $problem) {
        hard('case mismatch: ' . $problem, 'The autoloader will fail on Linux. Rename the file to match the class.');
    }
}

// ---------------------------------------------------------------------------
section('Database');

try {
    Database::run('SELECT 1');
    good('connection');

    $tables = array_column(
        Database::all('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()'),
        't'
    );

    $expected = [
        'users', 'categories', 'tasks', 'vault_accounts', 'social_ideas',
        'budget_months', 'budget_entries', 'refresh_tokens', 'otp_codes',
        'device_tokens', 'rate_limits', 'audit_logs',
    ];

    $missing = array_diff($expected, $tables);

    if ($missing === []) {
        good('all 12 tables present');
    } else {
        hard('missing tables: ' . implode(', ', $missing), 'Import database/schema.sql, then run: php tools/migrate.php');
    }

    if (in_array('schema_migrations', $tables, true)) {
        $applied = Database::first('SELECT COUNT(*) AS n FROM schema_migrations');
        good('migrations tracked', ($applied['n'] ?? 0) . ' applied');
    } else {
        soft('schema_migrations does not exist', 'Run: php tools/migrate.php');
    }

    // A timezone mismatch here is the subtle one: everything works, but every
    // expiry lands an hour off.
    $row    = Database::first('SELECT NOW() AS db_now');
    $dbNow  = strtotime((string) ($row['db_now'] ?? 'now'));
    $drift  = abs($dbNow - time());

    if ($drift <= 60) {
        good('PHP and MySQL clocks agree', "drift {$drift}s");
    } else {
        hard("PHP and MySQL clocks differ by {$drift}s", 'Check APP_TIMEZONE -- token and OTP expiry will be wrong by exactly this much.');
    }
} catch (Throwable $e) {
    hard('database unreachable', $e->getMessage());
}

// ---------------------------------------------------------------------------
if ($probeUrl !== null) {
    section("Live probe -- {$probeUrl}");

    $probe = static function (string $path): array {
        global $probeUrl;

        $ch = curl_init($probeUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HEADER         => true,
        ]);
        $raw    = (string) curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return ['status' => $status, 'raw' => $raw];
    };

    if (!str_starts_with($probeUrl, 'https://')) {
        soft('probe URL is not HTTPS', 'Serve over TLS. The refresh cookie is a 30-day credential.');
    } else {
        good('probe URL is HTTPS');
    }

    $health = $probe('/health');

    if ($health['status'] === 200) {
        good('GET /health is 200');
    } else {
        hard('GET /health returned ' . $health['status'], $health['status'] === 404
            ? 'mod_rewrite is probably off, or AllowOverride is not All for this directory.'
            : 'Check storage/logs/php-error.log.');
    }

    foreach (['/.env', '/src/Core/Database.php', '/storage/logs/mail.log', '/tools/backup.php'] as $secret) {
        $r = $probe($secret);

        if (in_array($r['status'], [403, 404], true)) {
            good("{$secret} is not served", 'HTTP ' . $r['status']);
        } else {
            hard("{$secret} returned " . $r['status'], 'This must not be reachable. Check the .htaccess guards and AllowOverride.');
        }
    }

    if (stripos($health['raw'], 'x-powered-by:') !== false) {
        soft('X-Powered-By header present', 'Set expose_php = Off in php.ini.');
    } else {
        good('X-Powered-By not exposed');
    }

    if (stripos($health['raw'], 'x-content-type-options:') !== false) {
        good('security headers present');
    } else {
        soft('X-Content-Type-Options missing', 'mod_headers is probably not enabled.');
    }
}

// ---------------------------------------------------------------------------
echo "\n" . str_repeat('=', 64) . "\n";
printf("  %d passed   %d warning(s)   %d failed\n", $pass, $warn, $fail);

if ($fail === 0 && $warn === 0) {
    echo "\n  Ready to deploy.\n\n";
} elseif ($fail === 0) {
    echo "\n  No blockers. Re-run with --production to see which warnings matter on a server.\n\n";
} else {
    echo "\n  Not ready -- fix the failures above.\n\n";
}

exit($fail === 0 ? 0 : 1);
