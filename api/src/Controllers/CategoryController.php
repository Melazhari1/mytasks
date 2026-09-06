<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Models\Category;
use App\Support\Validator;

final class CategoryController
{
    public function index(Request $request): void
    {
        $withCounts = $request->query('with_counts', '1') !== '0';

        Response::ok(Category::allForUser($request->userId(), $withCounts));
    }

    public function show(Request $request): void
    {
        $category = Category::findForUser($request->intParam('id'), $request->userId());

        if ($category === null) {
            throw HttpException::notFound('Category not found.');
        }

        Response::ok(Category::present($category));
    }

    public function store(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'name'  => 'required|string|min:1|max:100',
            'icon'  => 'nullable|string|max:50',
            'color' => 'nullable|hexcolor',
        ]);

        $userId = $request->userId();

        if (Category::nameTaken($userId, $data['name'])) {
            throw HttpException::conflict('You already have a category with that name.');
        }

        $id = Category::create(
            $userId,
            $data['name'],
            $data['icon'] ?? null,
            $data['color'] ?? null
        );

        Response::created(Category::present(Category::findForUser($id, $userId) ?? []));
    }

    public function update(Request $request): void
    {
        $id     = $request->intParam('id');
        $userId = $request->userId();

        if (!Category::existsForUser($id, $userId)) {
            throw HttpException::notFound('Category not found.');
        }

        $data = Validator::check($request->all(), [
            'name'  => 'nullable|string|min:1|max:100',
            'icon'  => 'nullable|string|max:50',
            'color' => 'nullable|hexcolor',
        ]);

        if (isset($data['name']) && Category::nameTaken($userId, $data['name'], $id)) {
            throw HttpException::conflict('You already have a category with that name.');
        }

        Category::update($id, $userId, $data);

        Response::ok(Category::present(Category::findForUser($id, $userId) ?? []));
    }

    public function destroy(Request $request): void
    {
        $id = $request->intParam('id');

        if (Category::delete($id, $request->userId()) === 0) {
            throw HttpException::notFound('Category not found.');
        }

        // Tasks in the category are removed by the ON DELETE CASCADE constraint.
        Response::noContent();
    }

    /**
     * Deletes every goal (category) the current user has, and with it every
     * task in one — same cascade as a single destroy(), just for all of them
     * at once. Irreversible, so this is meant to sit behind a confirm step
     * client-side (see chat's "delete all goals" flow); the API itself takes
     * the request at face value once it's actually sent.
     */
    public function destroyAll(Request $request): void
    {
        $deleted = Category::deleteAllForUser($request->userId());

        Response::ok(['deleted' => $deleted]);
    }
}
