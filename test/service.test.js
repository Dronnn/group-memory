import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApi } from './helpers/fake-api.js';
import { createMemoryStore } from './helpers/memory-store.js';
import { createService } from '../tgcloud/lib/service.js';
import { config as baseConfig } from '../tgcloud/lib/config.js';

export const GROUP_CHAT = -1001234567890;
export const ANNA = { id: 1, first_name: 'Анна' };
export const IGOR = { id: 2, first_name: 'Игорь' };
export const OUTSIDER = { id: 3, first_name: 'Чужой' };

/** Builds service around the in-memory store and fake Bot API. */
export function setup({ members, apiOptions = {}, now = () => Date.now() } = {}) {
  const store = createMemoryStore();
  const api = createFakeApi({
    members: members || {
      [`*:${ANNA.id}`]: { status: 'member' },
      [`*:${IGOR.id}`]: { status: 'member' },
    },
    ...apiOptions,
  });
  const config = {
    ...baseConfig,
    initialChatId: GROUP_CHAT,
    botUsername: 'group_memory_bot',
  };
  const service = createService({ store, api, config, now });
  return { store, api, config, service, now };
}

export const requestInput = (body, extra = {}) => ({ requestId: 'req-00000001', body, ...extra });

export async function createItem(service, actor, fields, rid = 'req-00000001') {
  const result = await service.execute('create', { requestId: rid, ...fields }, actor);
  return result.item;
}

export function isAppError(code) {
  return error => {
    assert.equal(error.name, 'AppError');
    assert.equal(error.code, code, error.message);
    return true;
  };
}

test('bootstrap returns group, actor and limits for a member', async () => {
  const { service } = setup();
  const data = await service.execute('bootstrap', {}, ANNA);
  assert.equal(data.group.id, 'group_memory');
  assert.equal(data.group.title, 'Учебная группа');
  assert.equal(data.actor.name, 'Анна');
  assert.equal(data.botUsername, 'group_memory_bot');
  assert.equal(data.limits.title, 120);
});

test('membership statuses decide access', async () => {
  const statuses = [
    ['creator', true],
    ['administrator', true],
    ['member', true],
    ['restricted', false, { is_member: false }],
    ['restricted', true, { is_member: true }],
    ['left', false],
    ['kicked', false],
  ];
  for (const [status, allowed, extra = {}] of statuses) {
    const { service, api } = setup();
    api.members[`${GROUP_CHAT}:${ANNA.id}`] = { status, ...extra };
    const result = service.execute('bootstrap', {}, ANNA);
    if (allowed) await result;
    else await assert.rejects(result, isAppError('ACCESS_DENIED'));
  }
});

test('unknown or unverifiable membership fails closed', async () => {
  const failed = setup({ apiOptions: { memberError: Object.assign(new Error('Bad Gateway'), { name: 'BotApiError', code: 502 }) } });
  await assert.rejects(failed.service.execute('list', {}, ANNA), isAppError('AUTH_UNAVAILABLE'));

  const missing = setup();
  await assert.rejects(missing.service.execute('list', {}, OUTSIDER), isAppError('ACCESS_DENIED'));
});

test('bot must be able to verify membership', async () => {
  const notAdmin = setup({ apiOptions: { botStatus: 'member' } });
  await assert.rejects(notAdmin.service.execute('bootstrap', {}, ANNA), isAppError('AUTH_UNAVAILABLE'));

  const botGone = setup({
    apiOptions: { botMemberError: Object.assign(new Error('Bad Request: chat not found'), { name: 'BotApiError', code: 400 }) },
  });
  await assert.rejects(botGone.service.execute('bootstrap', {}, ANNA), isAppError('AUTH_UNAVAILABLE'));
});

test('removal of the bot suspends access without touching data', async () => {
  const { service, store } = setup();
  const item = await createItem(service, ANNA, { body: 'Важная договорённость' });
  await service.botMembership(GROUP_CHAT, 'kicked');
  await assert.rejects(service.execute('read', { id: item.id }, ANNA), isAppError('AUTH_UNAVAILABLE'));
  assert.ok(await store.get('group_memory', item.id));
});

test('every action rechecks membership without a positive cache', async () => {
  const { service, api } = setup();
  const item = await createItem(service, ANNA, { body: 'Заметка' });
  await service.execute('read', { id: item.id }, ANNA);
  api.members[`${GROUP_CHAT}:${ANNA.id}`] = { status: 'left' };
  await assert.rejects(service.execute('read', { id: item.id }, ANNA), isAppError('ACCESS_DENIED'));
  await assert.rejects(service.execute('bootstrap', {}, ANNA), isAppError('ACCESS_DENIED'));
});

test('non-members are denied for all protected actions', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Заметка' });
  const actions = [
    ['bootstrap', {}],
    ['list', {}],
    ['read', { id: item.id }],
    ['create', requestInput('текст')],
    ['update', { id: item.id, expectedVersion: 1, requestId: 'req-00000009', body: 'другое' }],
    ['pin', { id: item.id, expectedVersion: 1, requestId: 'req-00000009', pinned: true }],
    ['trash', { id: item.id, expectedVersion: 1, requestId: 'req-00000009' }],
    ['restore', { id: item.id, expectedVersion: 1, requestId: 'req-00000009' }],
    ['history', { id: item.id }],
    ['tags', {}],
    ['export', { format: 'json' }],
    ['attachment', { id: item.id, requestId: 'req-00000009' }],
  ];
  for (const [action, input] of actions) {
    await assert.rejects(service.execute(action, input, OUTSIDER), isAppError('ACCESS_DENIED'), action);
  }
});

test('private chat reaches the same collection, other chats do not', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Заметка' });
  await service.checkConversation(ANNA.id, ANNA);
  await assert.rejects(service.checkConversation(-100777, ANNA), isAppError('ACCESS_DENIED'));
  await assert.rejects(service.checkConversation(ANNA.id, OUTSIDER), isAppError('ACCESS_DENIED'));
  assert.ok(item.id);
});

test('create is idempotent per request id', async () => {
  const { service } = setup();
  const first = await service.execute('create', requestInput('Одинаковый запрос'), ANNA);
  const second = await service.execute('create', requestInput('Одинаковый запрос'), ANNA);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.item.id, second.item.id);
  const list = await service.execute('list', {}, ANNA);
  assert.equal(list.items.length, 1);
});

test('saving the same source message converges on one memory', async () => {
  const { service, store } = setup();
  const snapshot = {
    body: 'Сохранённое сообщение',
    annotation: '',
    entities: [],
    source: { messageId: 55, chatId: GROUP_CHAT, date: 1, authorName: 'Игорь', authorId: IGOR.id },
  };
  const [a, b] = await Promise.all([
    service.saveSnapshot(snapshot, ANNA, 'req-00000002'),
    service.saveSnapshot(snapshot, IGOR, 'req-00000003'),
  ]);
  assert.equal(a.item.id, b.item.id);
  assert.equal(a.duplicate || b.duplicate, true);
  assert.equal((await store.list('group_memory', { view: 'active', limit: 10, terms: [] })).length, 1);
});

test('saving a trashed source returns the trashed memory for restoration', async () => {
  const { service } = setup();
  const snapshot = {
    body: 'Повторное сохранение',
    source: { messageId: 77, chatId: GROUP_CHAT, date: 1, authorName: 'Игорь' },
  };
  const saved = await service.saveSnapshot(snapshot, ANNA, 'req-00000002');
  await service.execute('trash', { id: saved.item.id, expectedVersion: saved.item.version, requestId: 'req-00000004' }, IGOR);
  const again = await service.saveSnapshot(snapshot, IGOR, 'req-00000005');
  assert.equal(again.duplicate, true);
  assert.equal(again.item.trashed, true);
  assert.equal(again.item.id, saved.item.id);
});

test('creator is the saver, source keeps the original author', async () => {
  const { service } = setup();
  const saved = await service.saveSnapshot(
    {
      body: 'Как настроить деплой',
      annotation: 'Примечание от Анны',
      source: { messageId: 91, chatId: GROUP_CHAT, date: 1, authorName: 'Игорь', authorId: IGOR.id, topicId: 7, url: 'https://t.me/c/1/91' },
    },
    ANNA,
    'req-00000002',
  );
  assert.equal(saved.item.creator.name, 'Анна');
  assert.equal(saved.item.annotation, 'Примечание от Анны');
  assert.equal(saved.item.source.authorName, 'Игорь');
  assert.equal(saved.item.source.topicId, 7);
});

test('external create cannot inject source, attachment or entities', async () => {
  const { service } = setup();
  for (const extra of [
    { source: { messageId: 1, chatId: GROUP_CHAT, date: 1, authorName: 'X' } },
    { attachment: { kind: 'document', fileId: 'secret' } },
    { entities: [{ type: 'bold', offset: 0, length: 1 }] },
  ]) {
    await assert.rejects(service.execute('create', requestInput('текст', extra), ANNA), isAppError('VALIDATION'));
  }
});

test('validation limits are enforced with field details', async () => {
  const { service } = setup();
  const cases = [
    [{ title: 'x'.repeat(121), body: 'текст' }, 'title'],
    [{ body: 'x'.repeat(20001) }, 'body'],
    [{ body: 'x'.repeat(10001), annotation: 'y'.repeat(10001) }, 'annotation'],
    [{ body: 'текст', tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) }, 'tags'],
    [{ body: 'текст', tags: ['x'.repeat(31)] }, 'tags'],
    [{ body: 'текст', url: 'ftp://example.com' }, 'url'],
    [{ body: '' }, 'body'],
  ];
  for (const [fields, expected] of cases) {
    await assert.rejects(
      service.execute('create', { requestId: 'req-00000060', ...fields }, ANNA),
      error => {
        assert.equal(error.code, 'VALIDATION');
        assert.ok(error.details.fields.includes(expected), `${expected} in ${error.details.fields}`);
        return true;
      },
      JSON.stringify(fields).slice(0, 60),
    );
  }
  await assert.rejects(service.execute('list', { query: 'x'.repeat(257) }, ANNA), isAppError('VALIDATION'));
  await assert.rejects(service.execute('list', { pageSize: 0 }, ANNA), isAppError('VALIDATION'));
  await assert.rejects(service.execute('create', { requestId: 'bad', body: 'x' }, ANNA), isAppError('VALIDATION'));
  await assert.rejects(service.execute('nope', {}, ANNA), isAppError('VALIDATION'));
});

test('search matches Cyrillic and Latin case-insensitively and combines filters', async () => {
  const { service } = setup();
  const deploy = await createItem(service, ANNA, {
    body: 'Как настроить деплой приложения\n```js\nnpm run deploy\n```',
    tags: ['deploy', 'практика'],
    url: 'https://example.com/deploy',
  }, 'req-00000010');
  const coffee = await createItem(service, IGOR, { body: 'Обычная заметка про кофе', tags: ['офтоп'] }, 'req-00000011');

  const byUpperCyrillic = await service.execute('list', { query: 'ДЕПЛОЙ' }, ANNA);
  assert.deepEqual(byUpperCyrillic.items.map(i => i.id), [deploy.id]);

  const byLatin = await service.execute('list', { query: 'NPM RUN' }, ANNA);
  assert.deepEqual(byLatin.items.map(i => i.id), [deploy.id]);

  const combined = await service.execute('list', { query: 'деплой кофе' }, ANNA);
  assert.equal(combined.items.length, 0);

  const tagAndQuery = await service.execute('list', { query: 'деплой', tag: 'deploy' }, ANNA);
  assert.deepEqual(tagAndQuery.items.map(i => i.id), [deploy.id]);
  const wrongTag = await service.execute('list', { tag: 'офтоп' }, ANNA);
  assert.deepEqual(wrongTag.items.map(i => i.id), [coffee.id]);

  const typed = await service.execute('list', { type: 'link' }, ANNA);
  assert.deepEqual(typed.items.map(i => i.id), [deploy.id]);

  const mine = await service.execute('list', { savedByMe: true }, IGOR);
  assert.deepEqual(mine.items.map(i => i.id), [coffee.id]);
});

test('query punctuation is treated as separators, never as wildcards', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Как настроить деплой приложения' });
  const percent = await service.execute('list', { query: '%' }, ANNA);
  assert.equal(percent.items.length, 0);
  const quoted = await service.execute('list', { query: '“деплой” (приложения)' }, ANNA);
  assert.deepEqual(quoted.items.map(i => i.id), [item.id]);
  const underscore = await service.execute('list', { query: 'деплой_приложения' }, ANNA);
  assert.equal(underscore.items.length, 0);
});

test('pagination is stable when new items arrive', async () => {
  let time = 1_000_000;
  const { service } = setup({ now: () => (time += 1000) });
  const first = await service.execute('create', { requestId: 'req-00000020', body: 'Первая' }, ANNA);
  const second = await service.execute('create', { requestId: 'req-00000021', body: 'Вторая' }, ANNA);
  const page1 = await service.execute('list', { pageSize: 1 }, ANNA);
  assert.deepEqual(page1.items.map(i => i.id), [second.item.id]);
  assert.ok(page1.nextCursor);
  const third = await service.execute('create', { requestId: 'req-00000022', body: 'Третья' }, ANNA);
  const page2 = await service.execute('list', { pageSize: 1, cursor: page1.nextCursor }, ANNA);
  assert.deepEqual(page2.items.map(i => i.id), [first.item.id]);
  assert.equal(page2.nextCursor, null);
  assert.ok(third.item.id > second.item.id);
  await assert.rejects(service.execute('create', { requestId: 'req-00000023', body: '' }, ANNA), isAppError('VALIDATION'));
});

test('sorting by oldest and by recently updated stays stable', async () => {
  let time = 5_000_000;
  const { service } = setup({ now: () => (time += 1000) });
  const a = (await service.execute('create', { requestId: 'req-00000030', body: 'A' }, ANNA)).item;
  const b = (await service.execute('create', { requestId: 'req-00000031', body: 'B' }, ANNA)).item;
  const oldest = await service.execute('list', { sort: 'oldest' }, ANNA);
  assert.deepEqual(oldest.items.map(i => i.id), [a.id, b.id]);
  await service.execute('update', { id: a.id, expectedVersion: a.version, requestId: 'req-00000032', body: 'A+' }, ANNA);
  const updated = await service.execute('list', { sort: 'updated' }, ANNA);
  assert.deepEqual(updated.items.map(i => i.id), [a.id, b.id]);
});

test('conflicting updates are rejected and keep the draft possible', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Исходный текст' });
  const [first, second] = await Promise.allSettled([
    service.execute('update', { id: item.id, expectedVersion: item.version, requestId: 'req-00000040', body: 'Правка Анны' }, ANNA),
    service.execute('update', { id: item.id, expectedVersion: item.version, requestId: 'req-00000041', body: 'Правка Игоря' }, IGOR),
  ]);
  const fulfilled = [first, second].filter(r => r.status === 'fulfilled');
  const rejected = [first, second].filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'CONFLICT');
  assert.equal(rejected[0].reason.details.latest.version, 2);
  const current = await service.execute('read', { id: item.id }, ANNA);
  assert.equal(current.version, 2);
  assert.ok(['Правка Анны', 'Правка Игоря'].includes(current.body));
});

test('repeated mutations with one request id are no-ops', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Текст' });
  const done = await service.execute('update', { id: item.id, expectedVersion: 1, requestId: 'req-00000050', body: 'Новый текст' }, IGOR);
  assert.equal(done.item.version, 2);
  const again = await service.execute('update', { id: item.id, expectedVersion: 2, requestId: 'req-00000050', body: 'Новый текст' }, IGOR);
  assert.equal(again.item.version, 2);
  const history = await service.execute('history', { id: item.id }, ANNA);
  assert.equal(history.items.length, 2);
});

test('trash and restore preserve history and attribution', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Запись для корзины' });
  const updated = await service.execute('update', { id: item.id, expectedVersion: 1, requestId: 'req-00000051', body: 'Обновлённая' }, ANNA);
  const trashed = await service.execute('trash', { id: item.id, expectedVersion: updated.item.version, requestId: 'req-00000052' }, IGOR);
  assert.equal(trashed.item.trashed, true);
  assert.equal(trashed.item.deletedBy.name, 'Игорь');
  assert.equal(trashed.item.pinned, false);

  const active = await service.execute('list', {}, ANNA);
  assert.equal(active.items.length, 0);
  const trashView = await service.execute('list', { view: 'trash' }, ANNA);
  assert.deepEqual(trashView.items.map(i => i.id), [item.id]);

  await assert.rejects(
    service.execute('update', { id: item.id, expectedVersion: trashed.item.version, requestId: 'req-00000053', body: 'нельзя' }, ANNA),
    isAppError('VALIDATION'),
  );
  await assert.rejects(
    service.execute('pin', { id: item.id, expectedVersion: trashed.item.version, requestId: 'req-00000054', pinned: true }, ANNA),
    isAppError('VALIDATION'),
  );

  const restored = await service.execute('restore', { id: item.id, expectedVersion: trashed.item.version, requestId: 'req-00000055' }, IGOR);
  assert.equal(restored.item.trashed, false);
  assert.equal(restored.item.deletedBy, undefined);

  const history = await service.execute('history', { id: item.id }, ANNA);
  assert.deepEqual(history.items.map(r => r.event), ['restore', 'trash', 'update', 'create']);
  assert.equal(history.items.at(-1).snapshot.body, 'Запись для корзины');
});

test('pinning only affects the memory application', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Важное' });
  const pinned = await service.execute('pin', { id: item.id, expectedVersion: 1, requestId: 'req-00000056', pinned: true }, IGOR);
  assert.equal(pinned.item.pinned, true);
  const pinnedView = await service.execute('list', { view: 'pinned' }, ANNA);
  assert.deepEqual(pinnedView.items.map(i => i.id), [item.id]);
  await service.execute('trash', { id: item.id, expectedVersion: pinned.item.version, requestId: 'req-00000057' }, IGOR);
  const after = await service.execute('list', { view: 'pinned' }, ANNA);
  assert.equal(after.items.length, 0);
});

test('tags list covers active memories only', async () => {
  const { service } = setup();
  const a = await createItem(service, ANNA, { body: 'A', tags: ['javascript', 'Практика'] }, 'req-00000058');
  await createItem(service, IGOR, { body: 'B', tags: ['javascript'] }, 'req-00000059');
  await service.execute('trash', { id: a.id, expectedVersion: 1, requestId: 'req-00000061' }, ANNA);
  const tags = await service.execute('tags', {}, ANNA);
  assert.deepEqual(tags.tags, ['javascript']);
});

test('export pages active memories without protected references', async () => {
  const { service } = setup();
  const saved = await service.saveSnapshot(
    {
      body: 'С файлом',
      attachment: { kind: 'document', fileId: 'BQAC-secret', fileUniqueId: 'uniq-1', fileName: 'cheatsheet.pdf', mimeType: 'application/pdf', size: 123 },
      source: { messageId: 5, chatId: GROUP_CHAT, date: 1, authorName: 'Игорь' },
    },
    ANNA,
    'req-00000062',
  );
  await createItem(service, ANNA, { body: 'Без файла' }, 'req-00000063');
  const trashed = await createItem(service, IGOR, { body: 'В корзине' }, 'req-00000064');
  await service.execute('trash', { id: trashed.id, expectedVersion: 1, requestId: 'req-00000065' }, ANNA);

  const page = await service.execute('export', { format: 'json', pageSize: 25 }, ANNA);
  assert.equal(page.format, 'json');
  assert.equal(page.items.length, 2);
  assert.ok(!page.items.some(i => i.body === 'В корзине'));
  const json = JSON.stringify(page.items);
  assert.ok(!json.includes('BQAC-secret'));
  assert.ok(!json.includes('uniq-1'));
  const withFile = page.items.find(i => i.id === saved.item.id);
  assert.equal(withFile.attachment.fileName, 'cheatsheet.pdf');
  assert.match(withFile.attachment.note, /не резервная копия/);
});

test('export paginates with bounded pages', async () => {
  const { service } = setup();
  for (let i = 0; i < 3; i += 1) {
    await service.execute('create', { requestId: `req-0000007${i}`, body: `Запись ${i}` }, ANNA);
  }
  const first = await service.execute('export', { format: 'markdown', pageSize: 2 }, ANNA);
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await service.execute('export', { format: 'markdown', pageSize: 2, cursor: first.nextCursor }, ANNA);
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  await assert.rejects(service.execute('export', {}, ANNA), isAppError('VALIDATION'));
});

test('history and tags are protected like item reads', async () => {
  const { service } = setup();
  const item = await createItem(service, ANNA, { body: 'Заметка' });
  await assert.rejects(service.execute('history', { id: item.id }, OUTSIDER), isAppError('ACCESS_DENIED'));
  await assert.rejects(service.execute('tags', {}, OUTSIDER), isAppError('ACCESS_DENIED'));
  await assert.rejects(service.execute('export', { format: 'json' }, OUTSIDER), isAppError('ACCESS_DENIED'));
});

test('attachment delivery goes only to the requesting member', async () => {
  const { service, api } = setup();
  const saved = await service.saveSnapshot(
    {
      body: 'Фото схемы',
      attachment: { kind: 'photo', fileId: 'AgAD-secret', width: 100, height: 50 },
    },
    ANNA,
    'req-00000080',
  );
  const sent = await service.execute('attachment', { id: saved.item.id, requestId: 'req-00000081' }, IGOR);
  assert.equal(sent.status, 'sent');
  const last = api.sent.at(-1);
  assert.equal(last.method, 'sendPhoto');
  assert.equal(last.chat_id, IGOR.id);
  assert.equal(last.photo, 'AgAD-secret');

  await assert.rejects(service.execute('attachment', { id: saved.item.id, requestId: 'req-00000082' }, OUTSIDER), isAppError('ACCESS_DENIED'));
});

test('attachment start_required and unavailable states', async () => {
  const { service, api } = setup();
  const saved = await service.saveSnapshot(
    { body: 'Документ', attachment: { kind: 'document', fileId: 'BQAC-1', fileName: 'a.txt' } },
    ANNA,
    'req-00000083',
  );
  api.sendDocument = async () => {
    const error = new Error("Forbidden: bot can't initiate conversation with a user");
    error.name = 'BotApiError';
    error.code = 403;
    throw error;
  };
  const needStart = await service.execute('attachment', { id: saved.item.id, requestId: 'req-00000084' }, IGOR);
  assert.equal(needStart.status, 'start_required');
  assert.match(needStart.startUrl, /^https:\/\/t\.me\/group_memory_bot\?start=file_\d+$/);

  api.sendDocument = async () => {
    const error = new Error('Bad Request: wrong file identifier/HTTP URL specified');
    error.name = 'BotApiError';
    error.code = 400;
    throw error;
  };
  const gone = await service.execute('attachment', { id: saved.item.id, requestId: 'req-00000085' }, IGOR);
  assert.equal(gone.status, 'unavailable');
  const item = await service.execute('read', { id: saved.item.id }, IGOR);
  assert.equal(item.attachment.available, false);

  const plain = await createItem(service, ANNA, { body: 'Без файла' }, 'req-00000086');
  const none = await service.execute('attachment', { id: plain.id, requestId: 'req-00000087' }, ANNA);
  assert.equal(none.status, 'unavailable');
});

test('memories are scoped to the configured group', async () => {
  const { service, store } = setup();
  await createItem(service, ANNA, { body: 'Наша запись' });
  const time = Date.now();
  await store.insert('other_group', 'foreign', null, {
    current: {
      id: 0,
      displayId: 'M-0',
      groupId: 'other_group',
      title: 'Чужая',
      body: 'секрет',
      annotation: '',
      url: '',
      tags: [],
      type: 'text',
      pinned: false,
      trashed: false,
      creator: { id: 9, name: 'X' },
      editor: { id: 9, name: 'X' },
      createdAt: time,
      updatedAt: time,
      version: 1,
    },
    history: [],
    applied: [],
    searchText: 'чужая секрет',
  });
  const list = await service.execute('list', {}, ANNA);
  assert.deepEqual(list.items.map(i => i.title), ['Наша запись']);
  const found = await service.execute('list', { query: 'секрет' }, ANNA);
  assert.equal(found.items.length, 0);
});

test('chat migration preserves the collection and mapping', async () => {
  const { service, store } = setup();
  const item = await createItem(service, ANNA, { body: 'До миграции' });
  const newChat = -1009999999999;
  await service.migrateChat(GROUP_CHAT, newChat);
  const group = await store.getGroup('group_memory');
  assert.equal(group.chatId, newChat);
  const readBack = await service.execute('read', { id: item.id }, ANNA);
  assert.equal(readBack.body, 'До миграции');
});

test('missing group configuration fails closed', async () => {
  const store = createMemoryStore();
  const api = createFakeApi({ members: { [`0:${ANNA.id}`]: { status: 'member' } } });
  const service = createService({
    store,
    api,
    config: { ...baseConfig, initialChatId: 0, botUsername: 'group_memory_bot' },
  });
  await assert.rejects(service.execute('bootstrap', {}, ANNA), isAppError('CONFIG_REQUIRED'));
});
