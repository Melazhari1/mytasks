<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Models\SocialIdea;
use App\Support\Validator;

/**
 * CRUD for the "social media ideas" scratchpad: an idea, optional links, and
 * which platforms it's for. Both `idea` and `links` are free-form multiline
 * text (a textarea each on the frontend) — nothing here parses them.
 */
final class SocialIdeaController
{
    /**
     * The fixed set of platforms a card can be tagged with. Keys are what's
     * stored in the DB and sent over the API; label/color are cosmetic and
     * only used by the frontend's own copy of this list (assets/js/ui.js).
     */
    public const PLATFORMS = [
        'youtube', 'facebook', 'instagram', 'tiktok', 'x', 'linkedin',
        'pinterest', 'snapchat', 'whatsapp', 'telegram', 'threads', 'reddit',
    ];

    public const STATUSES = ['pending', 'future', 'done'];

    public function index(Request $request): void
    {
        $status = $request->query('status');

        if ($status !== null && !in_array($status, self::STATUSES, true)) {
            throw HttpException::badRequest("Invalid 'status'. Allowed values: " . implode(', ', self::STATUSES) . '.');
        }

        $platform = $request->query('platform');

        if ($platform !== null && !in_array($platform, self::PLATFORMS, true)) {
            throw HttpException::badRequest("Invalid 'platform'. Allowed values: " . implode(', ', self::PLATFORMS) . '.');
        }

        $result = SocialIdea::search($request->userId(), [
            'search'   => $request->query('search'),
            'status'   => $status,
            'platform' => $platform,
            'sort'     => $request->query('sort', 'created_at'),
            'dir'      => $request->query('dir', 'desc'),
            'page'     => $request->query('page', '1'),
            'per_page' => $request->query('per_page', '12'),
        ]);

        Response::json(['data' => $result['items'], 'meta' => $result['meta']]);
    }

    public function show(Request $request): void
    {
        $idea = SocialIdea::findForUser($request->intParam('id'), $request->userId());

        if ($idea === null) {
            throw HttpException::notFound('Idea not found.');
        }

        Response::ok(SocialIdea::present($idea));
    }

    public function store(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'idea'   => 'required|string|min:1|max:5000',
            'links'  => 'nullable|string|max:5000',
            'status' => 'nullable|string|in:' . implode(',', self::STATUSES),
        ]);

        $platforms = $this->readPlatforms($request);

        $id = SocialIdea::create(
            $request->userId(),
            $data['idea'],
            $data['links'] ?? null,
            $data['status'] ?? 'pending',
            $platforms
        );

        Response::created(SocialIdea::present(SocialIdea::findForUser($id, $request->userId()) ?? []));
    }

    public function update(Request $request): void
    {
        $id     = $request->intParam('id');
        $userId = $request->userId();

        if (!$this->exists($id, $userId)) {
            throw HttpException::notFound('Idea not found.');
        }

        $data = Validator::check($request->all(), [
            'idea'   => 'nullable|string|min:1|max:5000',
            'links'  => 'nullable|string|max:5000',
            'status' => 'nullable|string|in:' . implode(',', self::STATUSES),
        ]);

        if ($request->has('platforms')) {
            $data['platforms'] = $this->readPlatforms($request);
        }

        SocialIdea::update($id, $userId, $data);

        Response::ok(SocialIdea::present(SocialIdea::findForUser($id, $userId) ?? []));
    }

    public function destroy(Request $request): void
    {
        if (SocialIdea::delete($request->intParam('id'), $request->userId()) === 0) {
            throw HttpException::notFound('Idea not found.');
        }

        Response::noContent();
    }

    private function exists(int $id, int $userId): bool
    {
        return SocialIdea::findForUser($id, $userId) !== null;
    }

    /** @return list<string> */
    private function readPlatforms(Request $request): array
    {
        $raw = $request->input('platforms', []);

        if (!is_array($raw)) {
            throw HttpException::validation(['platforms' => ['Platforms must be a list.']]);
        }

        $platforms = array_values(array_unique(array_map('strval', $raw)));
        $invalid   = array_diff($platforms, self::PLATFORMS);

        if ($invalid !== []) {
            throw HttpException::validation(['platforms' => ['Unknown platform(s): ' . implode(', ', $invalid) . '.']]);
        }

        return $platforms;
    }
}
