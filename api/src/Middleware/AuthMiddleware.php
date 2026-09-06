<?php

declare(strict_types=1);

namespace App\Middleware;

use App\Core\HttpException;
use App\Core\Request;
use App\Models\User;
use App\Support\Jwt;

/**
 * Requires a valid `access` JWT and attaches the claims to the request.
 */
final class AuthMiddleware
{
    public function __invoke(Request $request): void
    {
        $token = $request->bearerToken();

        if ($token === null) {
            throw HttpException::unauthorized('Missing Authorization: Bearer <token> header.');
        }

        $claims = Jwt::decode($token, 'access');

        $userId = (int) ($claims['sub'] ?? 0);
        $user   = $userId > 0 ? User::find($userId) : null;

        if ($user === null) {
            throw HttpException::unauthorized('Account no longer exists.');
        }

        // A lockout has to bite here too, not only at /auth/login. Otherwise an
        // access token issued moments before the lockout keeps working for the
        // rest of its 15-minute life.
        if (User::isLocked($user)) {
            throw new HttpException(423, 'account_locked', 'This account is temporarily locked.');
        }

        $request->setAuth($claims);
    }
}
