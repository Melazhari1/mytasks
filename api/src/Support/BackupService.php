<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Database;
use App\Core\Env;
use PDO;
use ZipArchive;

/**
 * Whole-project backup: a plain-SQL database dump bundled into a zip together
 * with every other file under the project root (api/, web/, everything).
 *
 * No mysqldump dependency — the dump is written straight through the PDO
 * connection the app already uses, so it works wherever this app runs.
 *
 * The archive necessarily contains `api/.env` (APP_KEY, JWT_SECRET, the DB
 * password) because restoring the vault's encrypted passwords needs APP_KEY.
 * Treat the archive exactly like .env itself — see BACKUP_ZIP_PASSWORD below.
 */
final class BackupService
{
    private const FILENAME_PATTERN = '/^mytasks-backup-\d{4}-\d{2}-\d{2}_\d{6}\.zip$/';

    public static function projectRoot(): string
    {
        return dirname(API_ROOT);
    }

    public static function backupDir(): string
    {
        $dir = API_ROOT . '/storage/backups';

        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }

        return $dir;
    }

    /**
     * @return array{filename:string,path:string,size:int,created_at:string}
     */
    public static function create(): array
    {
        // Zipping the whole project and dumping every table can take a while
        // on a large install — this is an explicit admin action, not a
        // request in the hot path.
        @set_time_limit(0);

        $dir      = self::backupDir();
        $filename = 'mytasks-backup-' . date('Y-m-d_His') . '.zip';
        $path     = $dir . '/' . $filename;

        $zip = new ZipArchive();

        if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new \RuntimeException('Could not create the backup archive at ' . $path);
        }

        $zip->addFromString('database.sql', self::dumpDatabaseSql());

        $root    = str_replace('\\', '/', rtrim(self::projectRoot(), '/\\'));
        $exclude = str_replace('\\', '/', rtrim($dir, '/\\')) . '/';

        self::addDirectory($zip, $root, $exclude);
        self::applyEncryption($zip);

        $zip->close();

        return [
            'filename'   => $filename,
            'path'       => $path,
            'size'       => filesize($path) ?: 0,
            'created_at' => date('c'),
        ];
    }

    /**
     * @return list<array{filename:string,size:int,created_at:string}>
     */
    public static function list(): array
    {
        $files = glob(self::backupDir() . '/mytasks-backup-*.zip') ?: [];
        rsort($files);

        return array_map(static fn (string $path) => [
            'filename'   => basename($path),
            'size'       => filesize($path) ?: 0,
            'created_at' => date('c', filemtime($path) ?: time()),
        ], $files);
    }

    /** Resolves a filename to a path, refusing anything that isn't one of our own backups. */
    public static function find(string $filename): ?string
    {
        if (!preg_match(self::FILENAME_PATTERN, $filename)) {
            return null;
        }

        $path = self::backupDir() . '/' . $filename;

        return is_file($path) ? $path : null;
    }

    public static function delete(string $filename): bool
    {
        $path = self::find($filename);

        return $path !== null && @unlink($path);
    }

    /** Keeps the newest $keep local backups, deletes the rest. Returns the number removed. */
    public static function prune(int $keep): int
    {
        $files = glob(self::backupDir() . '/mytasks-backup-*.zip') ?: [];
        rsort($files);

        $toDelete = array_slice($files, max(0, $keep));

        foreach ($toDelete as $file) {
            @unlink($file);
        }

        return count($toDelete);
    }

    /**
     * Every table's CREATE TABLE plus its rows as INSERT statements.
     *
     * Table and column names come from SHOW TABLES / the row's own keys —
     * the database's own catalog, never user input — so they are safe to
     * interpolate directly; only values go through PDO::quote().
     */
    private static function dumpDatabaseSql(): string
    {
        $pdo = Database::connection();

        $sql = "-- MyTasks database backup\n"
            . '-- Generated: ' . date('c') . "\n"
            . "SET FOREIGN_KEY_CHECKS=0;\n\n";

        // ERRMODE_EXCEPTION is set on this connection (see Database::connection),
        // so query() below either returns a statement or throws — never false.
        $tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);

        foreach ($tables as $table) {
            $table = (string) $table;

            $create    = $pdo->query('SHOW CREATE TABLE `' . $table . '`')->fetch(PDO::FETCH_ASSOC);
            $createSql = $create['Create Table'] ?? null;

            if ($createSql === null) {
                continue;
            }

            $sql .= "DROP TABLE IF EXISTS `{$table}`;\n{$createSql};\n\n";

            $statement = $pdo->query('SELECT * FROM `' . $table . '`');
            $rowSql    = '';

            foreach ($statement as $row) {
                $columns = array_map(static fn (string $c) => '`' . $c . '`', array_keys($row));
                $values  = array_map(
                    static fn (mixed $v) => $v === null ? 'NULL' : $pdo->quote((string) $v),
                    array_values($row)
                );

                $rowSql .= 'INSERT INTO `' . $table . '` (' . implode(',', $columns) . ') VALUES ('
                    . implode(',', $values) . ");\n";
            }

            if ($rowSql !== '') {
                $sql .= $rowSql . "\n";
            }
        }

        $sql .= "SET FOREIGN_KEY_CHECKS=1;\n";

        return $sql;
    }

    private static function addDirectory(ZipArchive $zip, string $root, string $excludePrefix): void
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS)
        );

        foreach ($iterator as $file) {
            /** @var \SplFileInfo $file */
            $real = str_replace('\\', '/', $file->getPathname());

            // Never fold the backups directory into itself.
            if (str_starts_with($real, $excludePrefix)) {
                continue;
            }

            $localName = ltrim(substr($real, strlen($root)), '/');

            if ($localName === '') {
                continue;
            }

            if ($file->isDir()) {
                $zip->addEmptyDir($localName);
            } else {
                $zip->addFile($file->getPathname(), $localName);
            }
        }
    }

    /** AES-256 encrypts every entry when BACKUP_ZIP_PASSWORD is set. */
    private static function applyEncryption(ZipArchive $zip): void
    {
        $password = Env::get('BACKUP_ZIP_PASSWORD');

        if ($password === null || $password === '') {
            return;
        }

        $zip->setPassword($password);

        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);

            if ($name !== false) {
                $zip->setEncryptionName($name, ZipArchive::EM_AES_256);
            }
        }
    }
}
