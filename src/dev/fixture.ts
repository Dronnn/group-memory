import type { Bootstrap, Memory, Page, Revision } from '../types';
import { ApiError, type Transport } from '../api';

const actor = { id: 1001, name: 'Анна' };
const other = { id: 1002, name: 'Игорь' };
let seq = 3;

const memories: Memory[] = [
  {
    id: 1,
    displayId: 'M-1',
    groupId: 'group_memory',
    title: 'Нормализация Unicode',
    body: 'Для поиска используйте NFKC и toLowerCase.\n\n```js\ntext.normalize("NFKC").toLowerCase()\n```',
    annotation: '',
    url: 'https://unicode.org/reports/tr15/',
    tags: ['javascript', 'поиск'],
    type: 'link',
    pinned: true,
    creator: actor,
    editor: actor,
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 86400000,
    version: 2,
    trashed: false,
  },
  {
    id: 2,
    displayId: 'M-2',
    groupId: 'group_memory',
    title: 'Правило сохранения',
    body: 'Сохраняем только по явной команде. Обычную переписку бот не архивирует.',
    annotation: 'Договорились на созвоне',
    url: '',
    tags: ['правила'],
    type: 'text',
    pinned: false,
    creator: other,
    editor: other,
    createdAt: Date.now() - 86400000 * 2,
    updatedAt: Date.now() - 86400000 * 2,
    version: 1,
    trashed: false,
  },
];

const history: Record<number, Revision[]> = {
  1: [
    {
      version: 2,
      editor: actor,
      at: Date.now() - 86400000,
      event: 'update',
      snapshot: memories[0],
    },
    {
      version: 1,
      editor: actor,
      at: Date.now() - 86400000 * 3,
      event: 'create',
      snapshot: { ...memories[0], version: 1, url: '', tags: ['javascript'] },
    },
  ],
};

const bootstrap: Bootstrap = {
  group: { id: 'group_memory', title: 'Студенты и разработчики' },
  actor,
  botUsername: 'group_memory_bot',
  limits: { title: 120, body: 20000, annotation: 20000, tags: 10, tag: 30, pageSize: 25 },
};

function normalize(value: string) {
  return value.normalize('NFKC').toLowerCase();
}

function list(input: Record<string, unknown>): Page<Memory> {
  const view = String(input.view || 'active');
  const query = normalize(String(input.query || ''));
  const terms = query ? query.split(/[^\p{L}\p{N}_+-]+/u).filter(Boolean) : [];
  if (query && !terms.length) return { items: [], nextCursor: null };
  let items = memories.filter(item => (view === 'trash' ? item.trashed : !item.trashed));
  if (view === 'pinned') items = items.filter(item => item.pinned);
  if (input.savedByMe) items = items.filter(item => item.creator.id === actor.id);
  if (input.type) items = items.filter(item => item.type === input.type);
  if (input.tag) items = items.filter(item => item.tags.includes(String(input.tag)));
  if (terms.length) {
    items = items.filter(item => {
      const hay = normalize([item.title, item.body, item.annotation, item.url, ...item.tags].join(' '));
      return terms.every(term => hay.includes(term));
    });
  }
  const sort = String(input.sort || 'newest');
  items = [...items].sort((a, b) => {
    if (sort === 'oldest') return a.createdAt - b.createdAt || a.id - b.id;
    if (sort === 'updated') return b.updatedAt - a.updatedAt || b.id - a.id;
    return b.createdAt - a.createdAt || b.id - a.id;
  });
  return { items, nextCursor: null };
}

export const fixtureTransport: Transport = async input => {
  await new Promise(resolve => setTimeout(resolve, 120));
  const action = String(input.action || '');
  if (action === 'bootstrap') return bootstrap as never;
  if (action === 'list') return list(input) as never;
  if (action === 'tags') {
    return { tags: [...new Set(memories.filter(m => !m.trashed).flatMap(m => m.tags))].sort() } as never;
  }
  if (action === 'read') {
    const item = memories.find(m => m.id === Number(input.id));
    if (!item) throw new ApiError('NOT_FOUND', 'Запись не найдена');
    return item as never;
  }
  if (action === 'create') {
    const item: Memory = {
      id: seq,
      displayId: `M-${seq}`,
      groupId: 'group_memory',
      title: String(input.title || String(input.body || '').split('\n')[0] || 'Заметка').slice(0, 120),
      body: String(input.body || ''),
      annotation: String(input.annotation || ''),
      url: String(input.url || ''),
      tags: Array.isArray(input.tags) ? (input.tags as string[]) : [],
      type: input.url ? 'link' : 'text',
      pinned: false,
      creator: actor,
      editor: actor,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      trashed: false,
    };
    seq += 1;
    memories.unshift(item);
    return { item, duplicate: false } as never;
  }
  if (action === 'update' || action === 'pin' || action === 'trash' || action === 'restore') {
    const item = memories.find(m => m.id === Number(input.id));
    if (!item) throw new ApiError('NOT_FOUND', 'Запись не найдена');
    if (item.version !== Number(input.expectedVersion)) {
      throw new ApiError('CONFLICT', 'Запись уже изменена', { latest: item });
    }
    if (action === 'update') {
      item.title = String(input.title ?? item.title);
      item.body = String(input.body ?? item.body);
      item.annotation = String(input.annotation ?? item.annotation);
      item.tags = Array.isArray(input.tags) ? (input.tags as string[]) : item.tags;
      item.url = String(input.url ?? item.url);
    }
    if (action === 'pin') item.pinned = Boolean(input.pinned);
    if (action === 'trash') {
      item.trashed = true;
      item.pinned = false;
      item.deletedBy = actor;
    }
    if (action === 'restore') {
      item.trashed = false;
      delete item.deletedBy;
    }
    item.editor = actor;
    item.updatedAt = Date.now();
    item.version += 1;
    return { item } as never;
  }
  if (action === 'history') {
    return { items: history[Number(input.id)] || [], nextCursor: null } as never;
  }
  if (action === 'export') {
    return { items: memories.filter(m => !m.trashed), nextCursor: null, format: input.format } as never;
  }
  if (action === 'attachment') return { status: 'start_required', startUrl: 'https://t.me/group_memory_bot?start=file_1' } as never;
  throw new ApiError('VALIDATION', 'Неизвестное действие');
};
