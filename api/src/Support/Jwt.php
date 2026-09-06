<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;
use App\Core\HttpException;

/**
 * HS256 JSON Web Tokens, no external dependency.
 *
 * Three token types are issued, distinguished by the `typ` claim:
 *   - access    : short-lived, authorises API calls
 *   - challenge : issued after a correct password, only usable at /auth/verify-2fa
 *   - vault     : issued after a vault unlock, required by /vault/{id}/reveal
 *
 * Refresh tokens are deliberately NOT JWTs — they are opaque random strings
 * stored (hashed) in the database so they can actually be revoked.
 */
final class Jwt
{
    public static function issueAccess(int $userId, string $email, array $extra = []): string
    {
        return self::encode([
            'typ'   => 'access',
            'sub'   => $userId,
            'email' => $email,
        ] + $extra, Env::int('JWT_ACCESS_TTL', 900));
    }

    public static function issueChallenge(int $userId, string $method): string
    {
        return self::encode([
            'typ'    => 'challenge',
            'sub'    => $userId,
            'method' => $method,
        ], Env::int('JWT_CHALLENGE_TTL', 300));
    }

    public static function issueVaultUnlock(int $userId): string
    {
        return self::encode([
            'typ' => 'vault',
            'sub' => $userId,
        ], Env::int('JWT_VAULT_TTL', 300));
    }

    /** @param array<string,mixed> $claims */
    public static function encode(array $claims, int $ttlSeconds): string
    {
        $now = time();

        $payload = $claims + [
            'iss' => Env::get('JWT_ISSUER', 'mytasks-api'),
            'iat' => $now,
            'nbf' => $now,
            'exp' => $now + $ttlSeconds,
            'jti' => bin2hex(random_bytes(8)),
        ];

        $header = ['alg' => 'HS256', 'typ' => 'JWT'];

        $segments = [
            self::b64(json_encode($header, JSON_UNESCAPED_SLASHES)),
            self::b64(json_encode($payload, JSON_UNESCAPED_SLASHES)),
        ];

        $signing   = implode('.', $segments);
        $signature = hash_hmac('sha256', $signing, self::secret(), true);

        return $signing . '.' . self::b64($signature);
    }

    /**
     * Verify signature, expiry and (optionally) the token type.
     *
     * @return array<string,mixed> the decoded claims
     */
    public static function decode(string $token, ?string $expectedType = null): array
    {
        $parts = explode('.', $token);

        if (count($parts) !== 3) {
            throw HttpException::unauthorized('Malformed token.');
        }

        [$headerB64, $payloadB64, $signatureB64] = $parts;

        $header = json_decode(self::b64decode($headerB64) ?? '', true);

        if (!is_array($header) || ($header['alg'] ?? null) !== 'HS256') {
            // Reject "alg": "none" and algorithm-confusion attempts outright.
            throw HttpException::unauthorized('Unsupported token algorithm.');
        }

        $expected = hash_hmac('sha256', $headerB64 . '.' . $payloadB64, self::secret(), true);
        $provided = self::b64decode($signatureB64);

        if ($provided === null || !hash_equals($expected, $provided)) {
            throw HttpException::unauthorized('Invalid token signature.');
        }

        $claims = json_decode(self::b64decode($payloadB64) ?? '', true);

        if (!is_array($claims)) {
            throw HttpException::unauthorized('Malformed token payload.');
        }

        $now = time();

        if (isset($claims['nbf']) && $now < (int) $claims['nbf'] - 5) {
            throw HttpException::unauthorized('Token is not valid yet.');
        }

        if (!isset($claims['exp']) || $now >= (int) $claims['exp']) {
            throw new HttpException(401, 'token_expired', 'Token has expired.');
        }

        if ($expectedType !== null && ($claims['typ'] ?? null) !== $expectedType) {
            throw HttpException::unauthorized('Token is not valid for this endpoint.');
        }

        return $claims;
    }

    private static function secret(): string
    {
        $secret = Env::get('JWT_SECRET');

        if ($secret === null || strlen($secret) < 32) {
            throw new \RuntimeException('JWT_SECRET is missing or shorter than 32 characters. Run: php tools/keygen.php');
        }

        return $secret;
    }

    private static function b64(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function b64decode(string $data): ?string
    {
        $decoded = base64_decode(strtr($data, '-_', '+/'), true);

        return $decoded === false ? null : $decoded;
    }
}
