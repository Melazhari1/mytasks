import { Api, requireAuth, signOut, ApiError } from './api.js';
import {
  Theme, Icons, renderShell, emptyState, escapeHtml,
  modal, toast, confirmDanger, SOCIAL_PLATFORMS, socialBadge,
  IDEA_STATUSES, statusPill,
} from './ui.js';
import { initChatBox } from './chatbox.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);

const user = await requireAuth();
if (!user) throw new Error('redirecting');

renderShell({ active: 'social-ideas.html', user });
document.querySelector('[data-logout]').addEventListener('click', signOut);
initChatBox();

$('[data-action="new-idea"]').innerHTML = `${Icons.plus}New idea`;
$('[data-action="new-idea"]').addEventListener('click', () => ideaModal({ onSaved: load }));

/* --- Filter state ----------------------------------------------------------- */
const filters = { search: '', status: '', platform: '', page: 1, per_page: 12 };

$('#f-platform').insertAdjacentHTML('beforeend', SOCIAL_PLATFORMS.map((p) =>
  `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join(''));

$('#f-status').addEventListener('change', (event) => {
  filters.status = event.target.value;
  filters.page = 1;
  load();
});

$('#f-platform').addEventListener('change', (event) => {
  filters.platform = event.target.value;
  filters.page = 1;
  load();
});

let searchTimer;
$('#f-search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filters.search = event.target.value.trim();
    filters.page = 1;
    load();
  }, 280);
});

/* --- Load / render ------------------------------------------------------------ */
async function load() {
  const grid = $('[data-slot="grid"]');
  grid.innerHTML = Array.from({ length: 3 }, () =>
    '<div class="skeleton" style="height:180px;border-radius:14px"></div>').join('');

  try {
    const res = await Api.socialIdeas.list(filters);
    render(res.data, res.meta);
  } catch (err) {
    console.error(err);
    toast('Could not load your social ideas.', 'error');
  }
}

function render(ideas, meta) {
  const grid = $('[data-slot="grid"]');
  const filtered = Boolean(filters.search || filters.status || filters.platform);

  $('[data-slot="subtitle"]').textContent = meta.total === 0
    ? 'Content ideas, with links, tagged by platform.'
    : `${meta.total} idea${meta.total > 1 ? 's' : ''}${filtered ? ' matching.' : '.'}`;

  if (!ideas.length) {
    grid.replaceChildren(emptyState({
      title: filtered ? 'No matches' : 'No ideas yet',
      message: filtered
        ? 'Nothing matches these filters.'
        : 'Jot down a content idea, drop in a link or two, and tag which platforms it fits.',
      actionLabel: filtered ? null : 'New idea',
      onAction: filtered ? null : () => ideaModal({ onSaved: load }),
    }));
    grid.style.display = 'block';
    renderPager(meta);
    return;
  }

  grid.style.display = '';
  grid.innerHTML = ideas.map(card).join('');

  grid.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const res = await Api.socialIdeas.get(btn.dataset.edit);
      ideaModal({ idea: res.data, onSaved: load });
    }));

  grid.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', () => remove(btn.dataset.delete)));

  renderPager(meta);
}

/** Each non-empty line of `links` becomes its own row; anything that looks
 *  like a URL is a clickable link, plain text otherwise. */
function renderLinks(links) {
  const lines = (links ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

  if (!lines.length) return '<div class="none">No links yet.</div>';

  return lines.map((line) => {
    const isUrl = /^(https?:\/\/|www\.)\S+$/i.test(line);
    if (!isUrl) return `<div>${escapeHtml(line)}</div>`;

    const href = line.startsWith('www.') ? `https://${line}` : line;
    return `<div><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(line)}</a></div>`;
  }).join('');
}

function card(idea) {
  const badges = idea.platforms.map((key) => socialBadge(key, { size: 26 })).join('');

  return `
    <article class="idea-card">
      <div class="idea-card__badges">${badges}${statusPill(idea.status)}</div>

      <div>
        <div class="idea-card__label">Idea</div>
        <div class="idea-card__idea">${escapeHtml(idea.idea)}</div>
      </div>

      <hr class="idea-card__divider">

      <div>
        <div class="idea-card__label">Links</div>
        <div class="idea-card__links">${renderLinks(idea.links)}</div>
      </div>

      <div class="idea-card__actions">
        <button class="icon-btn" data-edit="${idea.id}" aria-label="Edit idea">${Icons.edit}</button>
        <button class="icon-btn" data-delete="${idea.id}" aria-label="Delete idea">${Icons.trash}</button>
      </div>
    </article>`;
}

function renderPager(meta) {
  const host = $('[data-slot="pager"]');

  if (!meta || meta.total_pages <= 1) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = `
    <button class="btn btn--ghost btn--sm" data-page="prev" ${meta.page <= 1 ? 'disabled' : ''}>Previous</button>
    <span style="font-size:.83rem;color:var(--text-muted)">Page ${meta.page} of ${meta.total_pages}</span>
    <button class="btn btn--ghost btn--sm" data-page="next"
            ${meta.page >= meta.total_pages ? 'disabled' : ''}>Next</button>`;

  host.querySelector('[data-page="prev"]')?.addEventListener('click', () => { filters.page--; load(); });
  host.querySelector('[data-page="next"]')?.addEventListener('click', () => { filters.page++; load(); });
}

/* --- Create / edit modal ----------------------------------------------------- */
function ideaModal({ idea = null, onSaved }) {
  const editing = Boolean(idea);
  const selected = new Set(idea?.platforms ?? []);

  const { dialog } = modal({
    title: editing ? 'Edit idea' : 'New idea',
    confirmLabel: editing ? 'Save changes' : 'Create idea',
    wide: true,
    body: `
      <div class="field">
        <label for="s-idea">Idea</label>
        <textarea id="s-idea" maxlength="5000" required rows="5"
                  placeholder="What's the idea?">${escapeHtml(idea?.idea ?? '')}</textarea>
      </div>

      <div class="field">
        <label for="s-links">Links</label>
        <textarea id="s-links" maxlength="5000" rows="4"
                  placeholder="One link per line — references, inspiration, drafts…">${escapeHtml(idea?.links ?? '')}</textarea>
      </div>

      <div class="field">
        <label for="s-status">Status</label>
        <select id="s-status">
          ${IDEA_STATUSES.map((s) => `
            <option value="${s.key}" ${(idea?.status ?? 'pending') === s.key ? 'selected' : ''}>
              ${escapeHtml(s.label)}
            </option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label>Platforms</label>
        <div class="platform-picker" role="group" aria-label="Platforms">
          ${SOCIAL_PLATFORMS.map((p) => `
            <button type="button" class="platform-opt" data-platform="${p.key}"
                    aria-pressed="${selected.has(p.key)}">
              ${socialBadge(p.key, { size: 22 })}<span>${escapeHtml(p.label)}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const ideaText = dlg.querySelector('#s-idea').value.trim();

      if (!ideaText) {
        errorBox.textContent = 'An idea is required.';
        errorBox.hidden = false;
        return false;
      }

      const payload = {
        idea: ideaText,
        links: dlg.querySelector('#s-links').value.trim() || null,
        status: dlg.querySelector('#s-status').value,
        platforms: [...dlg.querySelectorAll('[data-platform][aria-pressed="true"]')]
          .map((btn) => btn.dataset.platform),
      };

      try {
        if (editing) await Api.socialIdeas.update(idea.id, payload);
        else await Api.socialIdeas.create(payload);

        toast(editing ? 'Idea updated.' : 'Idea created.', 'ok');
        onSaved?.();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not save that idea.';
        errorBox.hidden = false;
        return false;
      }
    },
  });

  dialog.querySelectorAll('[data-platform]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
    });
  });
}

function remove(id) {
  confirmDanger({
    title: 'Delete idea',
    message: 'This idea will be removed permanently. This cannot be undone.',
    onConfirm: async () => {
      try {
        await Api.socialIdeas.remove(id);
        toast('Idea deleted.', 'ok');
        load();
      } catch {
        toast('Could not delete that idea.', 'error');
      }
    },
  });
}

load();
