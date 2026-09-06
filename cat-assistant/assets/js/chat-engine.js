/* =============================================================================
   Chat logic for the Cat Assistant — same two-layer design as the main app's
   web/assets/js/chatbox.js (fixed-grammar parser first, local Ollama via
   /chat/interpret as fallback), reused conceptually rather than by import:
   chatbox.js owns its own DOM, and this widget renders differently (message
   bubbles with avatars, a confirm step the caller renders), so this is a
   parallel, presentation-free copy — send() returns data, never touches the
   DOM. See web/README.md's "The command chat" section for the shared grammar.

   Reply text is bilingual (English/Arabic) via the shared chat-strings.js —
   detectLang() on your message picks which language the reply comes back
   in, same as chatbox.js.
   ========================================================================== */
import { Api, ApiError } from '../../../web/assets/js/api.js';
import { escapeHtml, formatDate } from '../../../web/assets/js/ui.js';
import { T, detectLang } from '../../../web/assets/js/chat-strings.js';

let categoriesCache = null;

export const HELP_TEXT = T.en.helpText;

const COMMANDS = [
  { test: /^(?:help|\?)$/i, run: async (m, lang) => reply(T[lang].helpText) },
  { test: /^add\s+goal\s+(.+)$/i, run: (m, lang) => addGoal(m[1].trim(), lang) },
  { test: /^add\s+task\s+(.+)$/i, run: (m, lang) => addTask(m[1], lang) },
  { test: /^list\s+goals$/i, run: (m, lang) => listGoals(lang) },
  { test: /^list\s+tasks?(?:\s+(.+))?$/i, run: (m, lang) => listTasks(m[1]?.trim() ?? null, lang) },
  { test: /^(?:done|complete|finish)\s+(.+)$/i, run: (m, lang) => completeTask(m[1].trim(), lang) },
  { test: /^(?:delete|remove)\s+task\s+(.+)$/i, run: (m, lang) => deleteTaskFlow(m[1].trim(), lang) },
  { test: /^(?:delete|remove|clear)\s+all\s+(?:my\s+)?goals$/i, run: (m, lang) => deleteAllGoalsFlow(lang) },
  { test: /^(?:delete|remove)\s+goal\s+(.+)$/i, run: (m, lang) => deleteGoalFlow(m[1].trim(), lang) },
];

/** Plain text/HTML reply — the normal case. */
function reply(html) {
  return { html, confirm: null };
}

/** A destructive action needs a Yes/Cancel step first. The caller (chat
 *  view) renders the two buttons and calls run() on confirm. */
function confirmStep(promptHtml, confirmLabel, run) {
  return { html: null, confirm: { promptHtml, confirmLabel, run } };
}

/**
 * Entry point. `persona` is one of ChatController's TONES keys
 * ("friendly"/"professional"/"playful"/"blunt"), `catName` is the Settings
 * → General "Cat Name" — both only matter for messages that fall through to
 * the LLM; the fixed-grammar layer is tone-neutral. `lang` is detected once
 * from your raw text and threaded through every handler below.
 */
export async function sendMessage(text, { personaKey, catName } = {}) {
  const lang = detectLang(text);

  for (const command of COMMANDS) {
    const match = text.match(command.test);
    if (match) return command.run(match, lang);
  }

  return interpretWithLlm(text, lang, personaKey, catName);
}

async function interpretWithLlm(text, lang, personaKey, catName) {
  let parsed;

  try {
    const res = await Api.chat.interpret(text, personaKey, catName);
    parsed = res.data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      return reply(T[lang].ollamaFallbackDown);
    }
    return reply(T[lang].fallback);
  }

  if (!parsed || !parsed.intent || parsed.intent === 'unknown') return reply(T[lang].fallback);

  return runInterpreted(parsed, lang);
}

async function runInterpreted(parsed, lang) {
  switch (parsed.intent) {
    case 'help':
      return reply(T[lang].helpText);
    case 'chat':
      return reply(escapeHtml((parsed.reply ?? '').trim()) || T[lang].chatFallback);
    case 'add_goal':
      return addGoal((parsed.goal ?? parsed.title ?? '').trim(), lang);
    case 'add_task':
      return addTaskFromFields({
        title: (parsed.title ?? '').trim(),
        due: parsed.due_date ?? null,
        priority: parsed.priority ?? null,
        goal: parsed.goal ?? null,
      }, lang);
    case 'list_goals':
      return listGoals(lang);
    case 'list_tasks':
      return listTasks(parsed.filter ?? null, lang);
    case 'done': {
      const fragment = (parsed.fragment ?? parsed.title ?? '').trim();
      return fragment ? completeTask(fragment, lang) : reply(T[lang].whichTaskDone);
    }
    case 'delete_task': {
      const fragment = (parsed.fragment ?? parsed.title ?? '').trim();
      return fragment ? deleteTaskFlow(fragment, lang) : reply(T[lang].whichTaskDelete);
    }
    case 'delete_goal': {
      const fragment = (parsed.fragment ?? parsed.goal ?? '').trim();
      return fragment ? deleteGoalFlow(fragment, lang) : reply(T[lang].whichGoalDelete);
    }
    case 'delete_all_goals':
      return deleteAllGoalsFlow(lang);
    default:
      return reply(T[lang].fallback);
  }
}

/* --- Shared lookups ----------------------------------------------------------- */
async function getCategories(force = false) {
  if (categoriesCache && !force) return categoriesCache;
  const res = await Api.categories.list(true);
  categoriesCache = res.data;
  return categoriesCache;
}

function findCategory(categories, name) {
  const needle = name.trim().toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === needle)
    ?? categories.find((c) => c.name.toLowerCase().includes(needle));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function resolveDuePhrase(phrase) {
  const p = phrase.trim().toLowerCase();
  if (p === 'today') return isoDate(new Date());

  if (p === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return isoDate(d);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;

  const weekday = p.length >= 3 ? WEEKDAYS.findIndex((w) => w.startsWith(p)) : -1;

  if (weekday !== -1) {
    const d = new Date();
    d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7));
    return isoDate(d);
  }

  return null;
}

const DATE_WORD = 'today|tomorrow|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?'
  + '|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\\d{4}-\\d{2}-\\d{2}';

const TRIGGER_PATTERN = new RegExp(
  '\\b(?:'
  + '(?<goal1>in\\s+goal)'
  + '|(?<goal2>under\\s+goal)'
  + '|(?<goal3>for\\s+goal)'
  + '|(?<goal4>goal)'
  + '|(?<priority1>with\\s+priority)'
  + '|(?<priority2>at\\s+priority)'
  + '|(?<priority3>priority)'
  + '|(?<due1>due\\s+on)'
  + '|(?<due2>due\\s+by)'
  + '|(?<due3>due)'
  + `|(?:for|on|by)\\s+(?<dueWord>${DATE_WORD})`
  + ')\\b',
  'gi'
);

const TRIGGER_GROUP_FLAGS = {
  goal1: 'goal', goal2: 'goal', goal3: 'goal', goal4: 'goal',
  priority1: 'priority', priority2: 'priority', priority3: 'priority',
  due1: 'due', due2: 'due', due3: 'due',
};

function parseTaskFlags(text) {
  const matches = [...text.matchAll(TRIGGER_PATTERN)];

  if (!matches.length) return { title: text.trim(), due: null, priority: null, goal: null };

  const title = text.slice(0, matches[0].index).trim();
  const flags = {};

  matches.forEach((m, i) => {
    const groups = m.groups ?? {};
    let flag = null;
    let value = null;

    if (groups.dueWord !== undefined) {
      flag = 'due';
      value = groups.dueWord;
    } else {
      const groupName = Object.keys(TRIGGER_GROUP_FLAGS).find((name) => groups[name] !== undefined);
      flag = groupName ? TRIGGER_GROUP_FLAGS[groupName] : null;

      if (flag) {
        const start = m.index + m[0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        value = text.slice(start, end).trim();
      }
    }

    if (flag && value && !(flag in flags)) flags[flag] = value;
  });

  return { title, due: flags.due ?? null, priority: flags.priority ?? null, goal: flags.goal ?? null };
}

/* --- Handlers ------------------------------------------------------------- */
async function addGoal(name, lang) {
  if (!name) return reply(T[lang].addGoalMissingName);

  await Api.categories.create({ name });
  await getCategories(true);

  return reply(T[lang].goalCreated(escapeHtml(name)));
}

async function addTask(raw, lang) {
  return addTaskFromFields(parseTaskFlags(raw), lang);
}

async function addTaskFromFields({ title, due, priority, goal }, lang) {
  if (!title) return reply(T[lang].taskMissingTitle);

  const categories = await getCategories();

  if (!categories.length) return reply(T[lang].noGoalsYetForTask);

  let category;

  if (goal) {
    category = findCategory(categories, goal);
    if (!category) return reply(T[lang].goalNotFound(escapeHtml(goal)));
  } else {
    category = [...categories].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  }

  const payload = { category_id: category.id, title };

  if (priority && ['low', 'medium', 'high'].includes(priority.toLowerCase())) {
    payload.priority = priority.toLowerCase();
  }

  let dueNote = '';

  if (due) {
    const resolved = resolveDuePhrase(due);
    if (resolved) {
      payload.due_date = resolved;
      dueNote = T[lang].dueNoteResolved(escapeHtml(resolved));
    } else {
      dueNote = T[lang].dueNoteUnresolved(escapeHtml(due));
    }
  }

  await Api.tasks.create(payload);

  return reply(T[lang].taskAdded(escapeHtml(title), escapeHtml(category.name), dueNote));
}

async function listGoals(lang) {
  const categories = await getCategories(true);

  if (!categories.length) return reply(T[lang].noGoalsYet);

  const rows = categories.map((c) => `
    <li>${escapeHtml(c.icon || '🎯')} ${escapeHtml(c.name)}
      <span class="chat-msg__meta">${T[lang].openCount(c.stats?.pending ?? 0)}</span></li>`).join('');

  return reply(`<b>${T[lang].yourGoals}</b><ul class="chat-list">${rows}</ul>`);
}

async function listTasks(filterWord, lang) {
  const filters = { per_page: 8, sort: 'due_date', dir: 'asc', status: 'pending' };
  let label = T[lang].openTasks;

  if (filterWord) {
    const w = filterWord.toLowerCase();

    if (['today', 'tomorrow', 'week', 'month', 'overdue', 'upcoming'].includes(w)) {
      filters.date = w;
      label = T[lang].tasksFiltered(w);
    } else if (['done', 'completed'].includes(w)) {
      filters.status = 'completed';
      filters.sort = 'created_at';
      filters.dir = 'desc';
      label = T[lang].completedTasks;
    } else if (!['pending', 'open'].includes(w)) {
      const categories = await getCategories();
      const category = findCategory(categories, w);

      if (category) {
        filters.category_id = category.id;
        label = T[lang].tasksInGoal(category.name);
      } else {
        filters.search = filterWord;
        label = T[lang].tasksMatching(filterWord);
      }
    }
  }

  const res = await Api.tasks.list(filters);
  const tasks = res.data;

  if (!tasks.length) return reply(`<b>${escapeHtml(label)}</b><div class="chat-msg__meta">${T[lang].nothingHere}</div>`);

  const rows = tasks.map((t) => {
    const mark = t.status === 'completed' ? '✓' : t.is_overdue ? '⚠' : '•';
    const due = t.due_date ? ` — ${escapeHtml(formatDate(t.due_at))}` : '';
    return `<li>${mark} ${escapeHtml(t.title)}${due}
      <span class="chat-msg__meta">(${escapeHtml(t.priority)}, ${escapeHtml(t.category?.name ?? '—')})</span></li>`;
  }).join('');

  const more = res.meta?.total > tasks.length
    ? `<div class="chat-msg__meta">${T[lang].moreCount(res.meta.total - tasks.length)}</div>`
    : '';

  return reply(`<b>${escapeHtml(label)}</b><ul class="chat-list">${rows}</ul>${more}`);
}

async function completeTask(fragment, lang) {
  const res = await Api.tasks.list({ status: 'pending', search: fragment, per_page: 20 });
  const matches = res.data;

  if (!matches.length) return reply(T[lang].taskNotFoundOpen(escapeHtml(fragment)));

  if (matches.length > 1) {
    const rows = matches.slice(0, 6).map((t) => `<li>${escapeHtml(t.title)}</li>`).join('');
    return reply(`${T[lang].ambiguousOpenTask}<ul class="chat-list">${rows}</ul>`);
  }

  const task = matches[0];
  const done = await Api.tasks.toggle(task.id);

  return reply(done.message ? escapeHtml(done.message) : T[lang].taskMarkedDone(escapeHtml(task.title)));
}

async function deleteTaskFlow(fragment, lang) {
  const res = await Api.tasks.list({ search: fragment, per_page: 20 });
  const matches = res.data;

  if (!matches.length) return reply(T[lang].taskNotFound(escapeHtml(fragment)));

  if (matches.length > 1) {
    const rows = matches.slice(0, 6).map((t) => `<li>${escapeHtml(t.title)}</li>`).join('');
    return reply(`${T[lang].ambiguousTask}<ul class="chat-list">${rows}</ul>`);
  }

  const task = matches[0];

  return confirmStep(T[lang].confirmDeleteTask(escapeHtml(task.title)), T[lang].confirmYesDelete, async () => {
    await Api.tasks.remove(task.id);
    return T[lang].taskDeleted(escapeHtml(task.title));
  });
}

async function deleteGoalFlow(fragment, lang) {
  const categories = await getCategories(true);
  const needle = fragment.toLowerCase();
  const matches = categories.filter((c) => c.name.toLowerCase().includes(needle));

  if (!matches.length) return reply(T[lang].goalNotFoundDelete(escapeHtml(fragment)));

  if (matches.length > 1) {
    const rows = matches.slice(0, 6).map((c) => `<li>${escapeHtml(c.name)}</li>`).join('');
    return reply(`${T[lang].ambiguousGoal}<ul class="chat-list">${rows}</ul>`);
  }

  const category = matches[0];
  const count = category.stats?.total ?? 0;
  const warning = T[lang].confirmDeleteGoal(escapeHtml(category.name), count);

  return confirmStep(warning, T[lang].confirmYesDelete, async () => {
    await Api.categories.remove(category.id);
    await getCategories(true);
    return T[lang].goalDeleted(escapeHtml(category.name));
  });
}

async function deleteAllGoalsFlow(lang) {
  const categories = await getCategories(true);

  if (!categories.length) return reply(T[lang].noGoalsToDelete);

  return confirmStep(T[lang].confirmDeleteAllGoals(categories.length), T[lang].confirmYesDeleteAll, async () => {
    const count = categories.length;
    await Api.categories.removeAll();
    await getCategories(true);
    return T[lang].allGoalsDeleted(count);
  });
}
