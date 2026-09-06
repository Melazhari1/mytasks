<?php

declare(strict_types=1);

use App\Controllers\AuthController;
use App\Controllers\BackupController;
use App\Controllers\BudgetController;
use App\Controllers\CategoryController;
use App\Controllers\ChatController;
use App\Controllers\SocialIdeaController;
use App\Controllers\TaskController;
use App\Controllers\VaultController;
use App\Controllers\VoiceController;
use App\Core\Env;
use App\Core\Request;
use App\Core\Response;
use App\Core\Router;
use App\Middleware\AuthMiddleware;
use App\Middleware\BackupKeyMiddleware;
use App\Middleware\VaultUnlockMiddleware;

return static function (Router $router): void {
    $auth        = new AuthMiddleware();
    $vaultUnlock = new VaultUnlockMiddleware();
    $backupKey   = new BackupKeyMiddleware();

    $authController     = new AuthController();
    $categoryController = new CategoryController();
    $taskController     = new TaskController();
    $vaultController    = new VaultController();
    $backupController   = new BackupController();
    $chatController     = new ChatController();
    $voiceController    = new VoiceController();
    $socialIdeaController = new SocialIdeaController();
    $budgetController   = new BudgetController();

    // -----------------------------------------------------------------------
    //  Public
    // -----------------------------------------------------------------------
    $router->get('/', static function (): void {
        Response::json([
            'name'      => Env::get('APP_NAME', 'MyTasks API'),
            'version'   => '1.0.0',
            'status'    => 'ok',
            'endpoints' => [
                'auth'       => '/auth',
                'categories' => '/categories',
                'tasks'      => '/tasks',
                'social_ideas' => '/social-ideas',
                'budget'     => '/budget',
                'vault'      => '/vault',
                'backup'     => '/backup',
                'chat'       => '/chat',
                'voice'      => '/voice',
                'health'     => '/health',
            ],
        ]);
    });

    $router->get('/health', static function (): void {
        $database = 'ok';

        try {
            \App\Core\Database::run('SELECT 1');
        } catch (\Throwable) {
            $database = 'unavailable';
        }

        Response::json([
            'status'    => $database === 'ok' ? 'healthy' : 'degraded',
            'database'  => $database,
            'php'       => PHP_VERSION,
            'timestamp' => date('c'),
        ], $database === 'ok' ? 200 : 503);
    });

    // -----------------------------------------------------------------------
    //  /auth — unauthenticated
    // -----------------------------------------------------------------------
    $router->group('/auth', [], static function (Router $r) use ($authController): void {
        $r->post('/register',                fn (Request $q) => $authController->register($q));
        $r->post('/login',                   fn (Request $q) => $authController->login($q));
        $r->post('/verify-2fa',              fn (Request $q) => $authController->verifyTwoFactor($q));
        $r->post('/resend-otp',              fn (Request $q) => $authController->resendOtp($q));
        $r->post('/refresh',                 fn (Request $q) => $authController->refresh($q));
        $r->post('/logout',                  fn (Request $q) => $authController->logout($q));

        // Biometric sign-in: challenge, then proof.
        $r->post('/biometric-challenge',     fn (Request $q) => $authController->biometricChallenge($q));
        $r->post('/mobile-biometric-login',  fn (Request $q) => $authController->biometricLogin($q));
    });

    // -----------------------------------------------------------------------
    //  /auth — authenticated
    // -----------------------------------------------------------------------
    $router->group('/auth', [$auth], static function (Router $r) use ($authController): void {
        $r->get('/me',                       fn (Request $q) => $authController->me($q));
        $r->post('/logout-all',              fn (Request $q) => $authController->logoutAll($q));
        $r->post('/change-password',         fn (Request $q) => $authController->changePassword($q));

        $r->post('/2fa/setup',               fn (Request $q) => $authController->setupTotp($q));
        $r->post('/2fa/confirm',             fn (Request $q) => $authController->confirmTotp($q));
        $r->post('/2fa/disable',             fn (Request $q) => $authController->disableTotp($q));

        $r->post('/biometric/enroll',        fn (Request $q) => $authController->enrollBiometric($q));
        $r->get('/devices',                  fn (Request $q) => $authController->listDevices($q));
        $r->delete('/devices/{deviceId}',    fn (Request $q) => $authController->revokeDevice($q));
    });

    // -----------------------------------------------------------------------
    //  /categories
    // -----------------------------------------------------------------------
    $router->group('/categories', [$auth], static function (Router $r) use ($categoryController): void {
        $r->get('/',          fn (Request $q) => $categoryController->index($q));
        $r->post('/',         fn (Request $q) => $categoryController->store($q));
        $r->get('/{id}',      fn (Request $q) => $categoryController->show($q));
        $r->put('/{id}',      fn (Request $q) => $categoryController->update($q));
        $r->patch('/{id}',    fn (Request $q) => $categoryController->update($q));
        $r->delete('/{id}',   fn (Request $q) => $categoryController->destroy($q));
        $r->delete('/',       fn (Request $q) => $categoryController->destroyAll($q));
    });

    // -----------------------------------------------------------------------
    //  /tasks
    // -----------------------------------------------------------------------
    $router->group('/tasks', [$auth], static function (Router $r) use ($taskController): void {
        $r->get('/',              fn (Request $q) => $taskController->index($q));
        $r->post('/',             fn (Request $q) => $taskController->store($q));
        $r->get('/summary',       fn (Request $q) => $taskController->summary($q));
        $r->get('/reminders',     fn (Request $q) => $taskController->reminders($q));
        $r->get('/{id}',          fn (Request $q) => $taskController->show($q));
        $r->put('/{id}',          fn (Request $q) => $taskController->update($q));
        $r->patch('/{id}',        fn (Request $q) => $taskController->update($q));
        $r->post('/{id}/toggle',  fn (Request $q) => $taskController->toggle($q));
        $r->delete('/{id}',       fn (Request $q) => $taskController->destroy($q));
    });

    // -----------------------------------------------------------------------
    //  /social-ideas
    // -----------------------------------------------------------------------
    $router->group('/social-ideas', [$auth], static function (Router $r) use ($socialIdeaController): void {
        $r->get('/',        fn (Request $q) => $socialIdeaController->index($q));
        $r->post('/',       fn (Request $q) => $socialIdeaController->store($q));
        $r->get('/{id}',    fn (Request $q) => $socialIdeaController->show($q));
        $r->put('/{id}',    fn (Request $q) => $socialIdeaController->update($q));
        $r->patch('/{id}',  fn (Request $q) => $socialIdeaController->update($q));
        $r->delete('/{id}', fn (Request $q) => $socialIdeaController->destroy($q));
    });

    // -----------------------------------------------------------------------
    //  /budget
    // -----------------------------------------------------------------------
    $router->group('/budget', [$auth], static function (Router $r) use ($budgetController): void {
        $r->get('/months',                       fn (Request $q) => $budgetController->indexMonths($q));
        $r->get('/months/{year}/{month}',        fn (Request $q) => $budgetController->showMonth($q));
        $r->put('/months/{year}/{month}',        fn (Request $q) => $budgetController->setSalary($q));
        $r->delete('/months/{year}/{month}',     fn (Request $q) => $budgetController->destroyMonth($q));
        $r->post('/months/{year}/{month}/entries', fn (Request $q) => $budgetController->storeEntry($q));

        $r->put('/entries/{id}',    fn (Request $q) => $budgetController->updateEntry($q));
        $r->delete('/entries/{id}', fn (Request $q) => $budgetController->destroyEntry($q));
    });

    // -----------------------------------------------------------------------
    //  /vault
    // -----------------------------------------------------------------------
    $router->group('/vault', [$auth], static function (Router $r) use ($vaultController, $vaultUnlock): void {
        $r->get('/',                 fn (Request $q) => $vaultController->index($q));
        $r->post('/',                fn (Request $q) => $vaultController->store($q));
        $r->get('/generate-password', fn (Request $q) => $vaultController->generatePassword($q));

        $r->post('/unlock',          fn (Request $q) => $vaultController->unlock($q));
        $r->post('/unlock/request-otp', fn (Request $q) => $vaultController->requestUnlockOtp($q));
        $r->post('/master-password', fn (Request $q) => $vaultController->setMasterPassword($q));

        $r->get('/{id}',             fn (Request $q) => $vaultController->show($q));
        $r->put('/{id}',             fn (Request $q) => $vaultController->update($q));
        $r->patch('/{id}',           fn (Request $q) => $vaultController->update($q));
        $r->delete('/{id}',          fn (Request $q) => $vaultController->destroy($q));
    });

    // Plain-text reads sit behind the extra unlock gate.
    $router->group('/vault', [$auth, $vaultUnlock], static function (Router $r) use ($vaultController): void {
        $r->post('/{id}/reveal', fn (Request $q) => $vaultController->reveal($q));
        $r->get('/export/all',   fn (Request $q) => $vaultController->export($q));
    });

    // -----------------------------------------------------------------------
    //  /backup — whole-project + database backups. No user's access token is
    //  enough on its own; BACKUP_KEY (set in .env) is required too, since
    //  this reaches every user's data, not just the caller's own.
    // -----------------------------------------------------------------------
    $router->group('/backup', [$auth, $backupKey], static function (Router $r) use ($backupController): void {
        $r->get('/',                    fn (Request $q) => $backupController->index($q));
        $r->post('/',                   fn (Request $q) => $backupController->store($q));
        $r->get('/{filename}/download', fn (Request $q) => $backupController->download($q));
        $r->delete('/{filename}',       fn (Request $q) => $backupController->destroy($q));
    });

    // -----------------------------------------------------------------------
    //  /chat — the command chat's fallback path. When its own fixed-grammar
    //  parser doesn't recognize a message, it lands here and a local Ollama
    //  model is asked to interpret it. See ChatController / OllamaClient.
    // -----------------------------------------------------------------------
    $router->group('/chat', [$auth], static function (Router $r) use ($chatController): void {
        $r->post('/interpret', fn (Request $q) => $chatController->interpret($q));
    });

    // -----------------------------------------------------------------------
    //  /voice — the mic button's transcription path (whisper.cpp, see
    //  WhisperClient) and the speaker's speech path (Piper, see PiperClient).
    //  Neither is a cloud API.
    // -----------------------------------------------------------------------
    $router->group('/voice', [$auth], static function (Router $r) use ($voiceController): void {
        $r->post('/transcribe', fn (Request $q) => $voiceController->transcribe($q));
        $r->post('/speak',      fn (Request $q) => $voiceController->speak($q));
    });
};
