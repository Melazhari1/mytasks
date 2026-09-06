<?php

declare(strict_types=1);

namespace App\Middleware;

use App\Core\Env;
use App\Core\HttpException;
use App\Core\Request;

/**
 * Second gate in front of the backup endpoints.
 *
 * The API has no admin role — every signed-in account is an ordinary user
 * that can only reach its own tasks and vault (see api/README.md). A backup
 * covers every user's data plus api/.env, so a plain access token is not
 * enough to trigger one; the operator-only BACKUP_KEY from .env is required
 * too, sent as X-Backup-Key. This mirrors the vault's unlock-token pattern.
 */
final class BackupKeyMiddleware
{
    public function __invoke(Request $request): void
    {
        $configured = Env::get('BACKUP_KEY');

        if ($configured === null || $configured === '') {
            throw new HttpException(
                403,
                'backup_disabled',
                'Backups are disabled. Set BACKUP_KEY in the API .env to enable this from the web UI.'
            );
        }

        $provided = $request->header('X-Backup-Key');

        if ($provided === null || !hash_equals($configured, $provided)) {
            throw HttpException::forbidden('Invalid backup key.');
        }
    }
}
