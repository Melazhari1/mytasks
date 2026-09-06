<?php

/**
 * Self-test for the security primitives. No database required.
 *
 *   php tools/selftest.php
 *
 * Checks encryption round-trip and tamper detection, JWT signing and
 * rejection of forged tokens, and TOTP against the RFC 6238 test vectors.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("CLI only.\n");
}

define('API_ROOT', dirname(__DIR__));

require API_ROOT . '/src/Core/Autoloader.php';

use App\Core\Autoloader;
use App\Core\Env;
use App\Support\Crypto;
use App\Support\Jwt;
use App\Support\Totp;
use App\Support\Validator;

Autoloader::register(API_ROOT . '/src', 'App\\');
Env::load(API_ROOT . '/.env');

$pass = 0;
$fail = 0;

function check(string $label, bool $condition, string $detail = ''): void
{
    global $pass, $fail;

    if ($condition) {
        $pass++;
        echo "  PASS  {$label}\n";
    } else {
        $fail++;
        echo "  FAIL  {$label}" . ($detail !== '' ? "  -> {$detail}" : '') . "\n";
    }
}

echo "== Crypto (AES-256-CBC + HMAC) ==\n";

$secret = 'c0rrect-horse-battery-staple';
$cipher = Crypto::encrypt($secret);

check('round-trips', Crypto::decrypt($cipher) === $secret);
check('ciphertext does not contain plaintext', !str_contains($cipher, 'horse'));
check('same input encrypts differently (random IV)', Crypto::encrypt($secret) !== Crypto::encrypt($secret));
check('empty string round-trips', Crypto::decrypt(Crypto::encrypt('')) === '');
check('unicode round-trips', Crypto::decrypt(Crypto::encrypt('كلمة السر 🔐')) === 'كلمة السر 🔐');

$raw       = base64_decode($cipher, true);
$tampered  = base64_encode(substr($raw, 0, -1) . chr(ord($raw[strlen($raw) - 1]) ^ 0xFF));
check('tampered ciphertext is rejected', Crypto::tryDecrypt($tampered) === null);
check('garbage input is rejected', Crypto::tryDecrypt('not-even-base64!!') === null);

echo "\n== JWT (HS256) ==\n";

$token  = Jwt::issueAccess(42, 'user@example.com');
$claims = Jwt::decode($token, 'access');

check('decodes its own token', (int) $claims['sub'] === 42);
check('carries the email claim', $claims['email'] === 'user@example.com');

try {
    Jwt::decode($token, 'vault');
    check('wrong token type rejected', false);
} catch (\Throwable) {
    check('wrong token type rejected', true);
}

// Flip one character of the signature.
$parts    = explode('.', $token);
$parts[2] = strrev($parts[2]);

try {
    Jwt::decode(implode('.', $parts), 'access');
    check('forged signature rejected', false);
} catch (\Throwable) {
    check('forged signature rejected', true);
}

// The classic "alg": "none" downgrade.
$noneHeader  = rtrim(strtr(base64_encode('{"alg":"none","typ":"JWT"}'), '+/', '-_'), '=');
$nonePayload = rtrim(strtr(base64_encode(json_encode(['typ' => 'access', 'sub' => 1, 'exp' => time() + 999])), '+/', '-_'), '=');

try {
    Jwt::decode("{$noneHeader}.{$nonePayload}.", 'access');
    check('alg=none rejected', false);
} catch (\Throwable) {
    check('alg=none rejected', true);
}

$expired = Jwt::encode(['typ' => 'access', 'sub' => 1], -10);

try {
    Jwt::decode($expired, 'access');
    check('expired token rejected', false);
} catch (\Throwable) {
    check('expired token rejected', true);
}

echo "\n== TOTP (RFC 6238 vectors) ==\n";

// RFC 4226 / 6238 shared secret: ASCII "12345678901234567890".
$rfcSecret = Totp::base32Encode('12345678901234567890');

check('base32 round-trips', Totp::base32Decode($rfcSecret) === '12345678901234567890');
check('base32 matches known encoding', rtrim($rfcSecret, '=') === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', $rfcSecret);

// RFC 6238 lists 8-digit codes; the last 6 digits are the 6-digit code.
$vectors = [
    59          => '287082',
    1111111109  => '081804',
    1111111111  => '050471',
    1234567890  => '005924',
    2000000000  => '279037',
];

foreach ($vectors as $time => $expected) {
    $actual = Totp::codeAt($rfcSecret, $time);
    check("T={$time} yields {$expected}", $actual === $expected, "got {$actual}");
}

$live = Totp::generateSecret();
check('generated secret verifies its own code', Totp::verify($live, Totp::codeAt($live)));
check('wrong code fails', !Totp::verify($live, '000000'));
check('drift of one step is accepted', Totp::verify($live, Totp::codeAt($live, null, -1), 1));
check('drift of five steps is not', !Totp::verify($live, Totp::codeAt($live, null, -5), 1));
check('provisioning URI is well formed', str_starts_with(Totp::provisioningUri($live, 'a@b.com'), 'otpauth://totp/'));

echo "\n== Validator ==\n";

try {
    Validator::check(['email' => 'nope'], ['email' => 'required|email']);
    check('rejects bad email', false);
} catch (\Throwable) {
    check('rejects bad email', true);
}

$clean = Validator::check(
    ['email' => '  USER@Example.COM ', 'n' => '42', 'flag' => 'true'],
    ['email' => 'required|email', 'n' => 'required|int|min:1', 'flag' => 'nullable|bool']
);

check('normalises email', $clean['email'] === 'user@example.com');
check('casts integers', $clean['n'] === 42);
check('casts booleans', $clean['flag'] === true);
check('normalises datetimes', Validator::normalizeDateTime('2026-08-15T18:30') === '2026-08-15 18:30:00');

echo "\n==================================\n";
printf(" PASSED: %d    FAILED: %d\n", $pass, $fail);
echo "==================================\n";

exit($fail === 0 ? 0 : 1);
