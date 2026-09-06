<?php

/**
 * Generates the two secrets the API needs.
 *
 *   php tools/keygen.php            print values
 *   php tools/keygen.php --write    write them into .env (creating it from
 *                                   .env.example if needed), leaving any
 *                                   existing values untouched
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script may only be run from the command line.\n");
}

$appKey    = 'base64:' . base64_encode(random_bytes(32));
$jwtSecret = bin2hex(random_bytes(32));

$write = in_array('--write', $argv, true);

if (!$write) {
    echo "APP_KEY={$appKey}\n";
    echo "JWT_SECRET={$jwtSecret}\n\n";
    echo "Paste these into api/.env, or re-run with --write to do it automatically.\n";
    exit(0);
}

$root    = dirname(__DIR__);
$envPath = $root . '/.env';

if (!is_file($envPath)) {
    if (!is_file($root . '/.env.example')) {
        exit("No .env.example found next to this script.\n");
    }

    copy($root . '/.env.example', $envPath);
    echo "Created .env from .env.example\n";
}

$contents = (string) file_get_contents($envPath);
$changed  = false;

foreach (['APP_KEY' => $appKey, 'JWT_SECRET' => $jwtSecret] as $key => $value) {
    if (preg_match("/^{$key}=(.*)$/m", $contents, $m) === 1) {
        if (trim($m[1]) !== '') {
            echo "{$key} already set — left alone.\n";
            continue;
        }

        $contents = preg_replace("/^{$key}=.*$/m", "{$key}={$value}", $contents) ?? $contents;
    } else {
        $contents .= "\n{$key}={$value}\n";
    }

    $changed = true;
    echo "{$key} written.\n";
}

if ($changed) {
    file_put_contents($envPath, $contents);
}

echo "\nDone. Never commit .env, and never change APP_KEY once vault entries exist —\n";
echo "doing so makes every stored password permanently undecryptable.\n";
