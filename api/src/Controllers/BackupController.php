<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\Env;
use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Support\Audit;
use App\Support\BackupService;
use App\Support\GoogleDriveUploader;
use App\Support\Validator;

final class BackupController
{
    public function index(Request $request): void
    {
        Response::ok([
            'backups'         => BackupService::list(),
            'drive_configured' => GoogleDriveUploader::isConfigured(),
        ]);
    }

    public function store(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'upload_to_drive' => 'nullable|bool',
        ]);

        $backup = BackupService::create();

        Audit::record($request->userId(), 'backup.created', $backup['filename'], $request);

        $drive = null;

        if (!empty($data['upload_to_drive'])) {
            if (!GoogleDriveUploader::isConfigured()) {
                throw new HttpException(
                    422,
                    'drive_not_configured',
                    'Set GOOGLE_SERVICE_ACCOUNT_FILE in .env before uploading to Google Drive.'
                );
            }

            try {
                $drive = GoogleDriveUploader::upload($backup['path'], $backup['filename']);
                Audit::record($request->userId(), 'backup.uploaded_to_drive', $backup['filename'], $request);
            } catch (\Throwable $e) {
                error_log('[backup] Drive upload failed: ' . $e->getMessage());

                throw new HttpException(502, 'drive_upload_failed', 'The backup was created but the Google Drive upload failed: ' . $e->getMessage());
            }
        }

        BackupService::prune(Env::int('BACKUP_KEEP', 10));

        Response::created([
            'filename'   => $backup['filename'],
            'size'       => $backup['size'],
            'created_at' => $backup['created_at'],
            'drive'      => $drive,
        ]);
    }

    public function download(Request $request): void
    {
        $filename = (string) ($request->param('filename') ?? '');
        $path     = BackupService::find($filename);

        if ($path === null) {
            throw HttpException::notFound('Backup not found.');
        }

        Audit::record($request->userId(), 'backup.downloaded', $filename, $request);

        if (!headers_sent()) {
            header('Content-Type: application/zip');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            header('Content-Length: ' . (string) filesize($path));
            header('Cache-Control: no-store');
        }

        readfile($path);
        exit;
    }

    public function destroy(Request $request): void
    {
        $filename = (string) ($request->param('filename') ?? '');

        if (!BackupService::delete($filename)) {
            throw HttpException::notFound('Backup not found.');
        }

        Audit::record($request->userId(), 'backup.deleted', $filename, $request);

        Response::noContent();
    }
}
