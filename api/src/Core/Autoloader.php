<?php

declare(strict_types=1);

namespace App\Core;

/**
 * Minimal PSR-4 autoloader so the project runs on a stock WAMP install
 * with no Composer step.
 */
final class Autoloader
{
    public static function register(string $baseDir, string $prefix = 'App\\'): void
    {
        $baseDir = rtrim($baseDir, '/\\') . DIRECTORY_SEPARATOR;
        $len     = strlen($prefix);

        spl_autoload_register(static function (string $class) use ($baseDir, $prefix, $len): void {
            if (strncmp($prefix, $class, $len) !== 0) {
                return;
            }

            $relative = substr($class, $len);
            $file     = $baseDir . str_replace('\\', DIRECTORY_SEPARATOR, $relative) . '.php';

            if (is_file($file)) {
                require $file;
            }
        });
    }
}
