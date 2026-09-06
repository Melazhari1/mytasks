<?php

declare(strict_types=1);

namespace App\Middleware;

use App\Core\HttpException;
use App\Core\Request;
use App\Support\Jwt;

/**
 * Second gate in front of plain-text vault reads.
 *
 * The client obtains a short-lived unlock token from POST /vault/unlock
 * (master password or OTP) and sends it as `X-Vault-Token`. An access token
 * alone is never enough to decrypt a stored password — that is the whole point
 * of the vault being separate from the rest of the API.
 */
final class VaultUnlockMiddleware
{
    public function __invoke(Request $request): void
    {
        $token = $request->header('X-Vault-Token')
            ?? (is_string($request->input('vault_token')) ? $request->input('vault_token') : null);

        if ($token === null || $token === '') {
            throw new HttpException(
                403,
                'vault_locked',
                'The vault is locked. Call POST /vault/unlock and resend the request with an X-Vault-Token header.'
            );
        }

        $claims = Jwt::decode($token, 'vault');

        if ((int) ($claims['sub'] ?? 0) !== $request->userId()) {
            throw HttpException::forbidden('This unlock token belongs to another account.');
        }
    }
}
