<?php

/**
 * Full project backup: zips api/, web/ and everything else under the project
 * root, bundles a plain-SQL database dump inside as database.sql, and
 * optionally pushes the archive to Google Drive.
 *
 *   php tools/backup.php                # local zip only
 *   php tools/backup.php --upload       # also upload to Google Drive
 *   php tools/backup.php --keep=20      # local backups to keep (default: BACKUP_KEEP, or 10)
 *
 * Windows Task Scheduler, nightly at 2am:
 *   C:\wamp64\bin\php\php8.x.x\php.exe C:\wamp64\www\xxp\mytasks\api\tools\backup.php --upload
 *
 * Linux cron:
 *   0 2 * * * php /var/www/mytasks/api/tools/backup.php --upload >> /var/log/mytasks-backup.log
 *
 * The archive contains api/.env — APP_KEY, JWT_SECRET, the DB password —
 * because restoring the vault's encrypted passwords needs APP_KEY. Handle
 * every backup file exactly as carefully as .env itself. Set
 * BACKUP_ZIP_PASSWORD in .env to AES-256 encrypt the archive's contents.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script may only be run from the command line.\n");
}

define('API_ROOT', dirname(__DIR__));

require API_ROOT . '/src/Core/Autoloader.php';

use App\Core\Autoloader;
use App\Core\Env;
use App\Support\BackupService;
use App\Support\GoogleDriveUploader;

Autoloader::register(API_ROOT . '/src', 'App\\');
Env::load(API_ROOT . '/.env');
date_default_timezone_set(Env::get('APP_TIMEZONE', 'UTC'));

$options = getopt('', ['upload', 'keep::']);
$upload  = array_key_exists('upload', $options);
$keep    = isset($options['keep']) && $options['keep'] !== false
    ? max(1, (int) $options['keep'])
    : Env::int('BACKUP_KEEP', 10);

function formatBytes(int $bytes): string
{
    $units = ['B', 'KB', 'MB', 'GB'];
    $size  = (float) $bytes;
    $i     = 0;

    while ($size >= 1024 && $i < count($units) - 1) {
        $size /= 1024;
        $i++;
    }

    return round($size, 1) . ' ' . $units[$i];
}

echo "Zipping the project and dumping the database...\n";

try {
    $backup = BackupService::create();
} catch (\Throwable $e) {
    fwrite(STDERR, 'Backup failed: ' . $e->getMessage() . "\n");
    exit(1);
}

printf("Created %s (%s)\n", $backup['filename'], formatBytes($backup['size']));

if ($upload) {
    if (!GoogleDriveUploader::isConfigured()) {
        fwrite(STDERR, "--upload was given but GOOGLE_SERVICE_ACCOUNT_FILE is not set in .env — skipping.\n");
    } else {
        echo "Uploading to Google Drive...\n";

        try {
            $result = GoogleDriveUploader::upload($backup['path'], $backup['filename']);
            printf("Uploaded as Drive file %s (%s)\n", $result['id'], $result['name'] ?? $backup['filename']);
        } catch (\Throwable $e) {
            fwrite(STDERR, 'Drive upload failed: ' . $e->getMessage() . "\n");
        }
    }
}

$pruned = BackupService::prune($keep);

if ($pruned > 0) {
    printf("Pruned %d old local backup(s), keeping the newest %d.\n", $pruned, $keep);
}
