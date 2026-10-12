import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchTerms, buildSearchText } from '../tgcloud/lib/search.js';
import {
  actorIdentity,
  content,
  decodeCursor,
  encodeCursor,
  normalize,
  pageSize,
  requestId,
} from '../tgcloud/lib/validation.js';
import { appLink, conversationKey, parseCommand, parseId } from '../tgcloud/lib/commands.js';
import { extractSnapshot, safeUrl } from '../tgcloud/lib/snapshot.js';
import { exportMemory, inferType, publicMemory } from '../tgcloud/lib/public.js';
import { config } from '../tgcloud/lib/config.js';

const limits = config.limits;
const appError = code => error => {
  assert.equal(error.code, code, `${code}: ${error.message}`);
  return true;
};

test('searchTerms splits, normalizes and bounds the query', () => {
  assert.equal(searchTerms('', limits), null);
  assert.equal(searchTerms('   ', limits), null);
  assert.deepEqual(searchTerms('  ДЕПЛОЙ  ', limits), ['деплой']);
  assert.deepEqual(searchTerms('NPM run деплой', limits), ['npm', 'run', 'деплой']);
  assert.deepEqual(searchTerms('деплой деплой', limits), ['деплой']);
  assert.deepEqual(searchTerms('%%% ...', limits), []);
  assert.throws(() => searchTerms('x'.repeat(257), limits), appError('VALIDATION'));
});

test('buildSearchText normalizes display text into a search blob', () => {
  const text = buildSearchText({
    title: 'Ｆｕｌｌ－ｗｉｄｔｈ',
    body: 'Ссылка https://Example.COM',
    annotation: 'Примечание',
    url: 'https://example.com',
    tags: ['Практика', 'npm'],
    attachment: { fileName: 'Шпаргалка.PDF' },
    source: { authorName: 'Игорь' },
  });
  assert.ok(text.includes('full-width'));
  assert.ok(text.includes('шпаргалка.pdf'));
  assert.ok(text.includes('практика'));
  assert.ok(text.includes('игорь'));
  assert.ok(!text.includes('Ｆ'));
});

test('normalize is NFKC, case-insensitive and whitespace-collapsed', () => {
  assert.equal(normalize('Ｈｅｌｌｏ   Мир'), 'hello мир');
  assert.equal(normalize(undefined), '');
});

test('actorIdentity refuses bots and missing ids, trims names', () => {
  assert.throws(() => actorIdentity(null), appError('ACCESS_DENIED'));
  assert.throws(() => actorIdentity({ id: 0 }), appError('ACCESS_DENIED'));
  assert.throws(() => actorIdentity({ id: 5, is_bot: true }), appError('ACCESS_DENIED'));
  assert.deepEqual(actorIdentity({ id: 5, first_name: 'Анна', last_name: 'М' }), { id: 5, name: 'Анна М' });
  assert.equal(actorIdentity({ id: 5, name: 'x'.repeat(200) }).name.length, 160);
  assert.equal(actorIdentity({ id: 5, username: 'user' }).name, 'user');
});

test('content validation derives titles, normalizes tags and enforces limits', () => {
  const fields = content({ body: 'Первая строка\nВторая', tags: ['#JavaScript', ' javascript ', 'Практика'] }, limits);
  assert.equal(fields.title, 'Первая строка');
  assert.deepEqual(fields.tags, ['javascript', 'практика']);
  assert.equal(content({ body: 'Текст', title: '  Мой заголовок  ' }, limits).title, 'Мой заголовок');
  assert.equal(content({ body: '', attachment: { fileName: 'файл.pdf' } }, limits).title, 'файл.pdf');
  assert.throws(() => content({}, limits), appError('VALIDATION'));
  assert.throws(() => content({ body: 'x'.repeat(20001) }, limits), appError('VALIDATION'));
  assert.throws(() => content({ body: 'x'.repeat(10001), annotation: 'y'.repeat(10001) }, limits), appError('VALIDATION'));
  assert.throws(() => content({ body: 'x', tags: new Set() }, limits), appError('VALIDATION'));
  assert.throws(() => content({ body: 'x', tags: ['плохой\u0000тег'] }, limits), appError('VALIDATION'));
  assert.throws(() => content({ body: 'x', url: 'javascript:alert(1)' }, limits), appError('VALIDATION'));
  assert.throws(() => content({ body: 'x', url: 'https://' }, limits), appError('VALIDATION'));
});

test('pageSize, requestId and cursors are bounded', () => {
  assert.equal(pageSize(undefined, limits), 25);
  assert.equal(pageSize(10, limits), 10);
  assert.equal(pageSize(100, limits), 25);
  assert.throws(() => pageSize(0, limits), appError('VALIDATION'));
  assert.equal(requestId('req-00000001'), 'req-00000001');
  assert.throws(() => requestId('short'), appError('VALIDATION'));
  assert.throws(() => requestId('не-латиница-1'), appError('VALIDATION'));
  const cursor = encodeCursor({ createdAt: 123, updatedAt: 456, id: 7 }, 'newest');
  assert.equal(cursor, '123:7');
  assert.equal(encodeCursor({ createdAt: 123, updatedAt: 456, id: 7 }, 'updated'), '456:7');
  assert.deepEqual(decodeCursor(cursor), { time: 123, id: 7 });
  assert.equal(decodeCursor(''), null);
  assert.throws(() => decodeCursor('abc'), appError('VALIDATION'));
  assert.throws(() => decodeCursor('1:0'), appError('VALIDATION'));
});

test('parseCommand accepts own commands, aliases and addressed shortcuts only', () => {
  assert.deepEqual(parseCommand('/remember текст', 'group_memory_bot'), { action: 'remember', args: 'текст' });
  assert.deepEqual(parseCommand('/remember@group_memory_bot текст', 'group_memory_bot'), { action: 'remember', args: 'текст' });
  assert.deepEqual(parseCommand('/save текст', 'group_memory_bot'), { action: 'remember', args: 'текст' });
  assert.deepEqual(parseCommand('/remember@Other_Bot текст', 'group_memory_bot'), null);
  assert.deepEqual(parseCommand('/unknown текст', 'group_memory_bot'), null);
  assert.deepEqual(parseCommand('обычный текст', 'group_memory_bot'), null);
  assert.deepEqual(parseCommand('@group_memory_bot запомни правило', 'group_memory_bot'), { action: 'remember', args: 'правило' });
  assert.deepEqual(parseCommand('@group_memory_bot найди ссылку', 'group_memory_bot'), { action: 'find', args: 'ссылку' });
  assert.deepEqual(parseCommand('@group_memory_bot память', 'group_memory_bot'), { action: 'memory', args: '' });
  assert.deepEqual(parseCommand('@another_bot запомни правило', 'group_memory_bot'), null);
  assert.deepEqual(parseCommand('@group_memory_bot запомни', 'group_memory_bot'), { action: 'remember', args: '' });
  assert.deepEqual(parseCommand('/remember', ''), { action: 'remember', args: '' });
});

test('parseId, appLink and conversationKey behave predictably', () => {
  assert.equal(parseId('M-12'), 12);
  assert.equal(parseId('#3'), 3);
  assert.equal(parseId(' 7 '), 7);
  assert.equal(parseId('0'), null);
  assert.equal(parseId('abc'), null);
  assert.equal(appLink('group_memory_bot', 'm_5'), 'https://t.me/group_memory_bot?startapp=m_5');
  assert.equal(appLink('@group_memory_bot'), 'https://t.me/group_memory_bot?startapp=memory');
  const message = { chat: { id: -100 }, message_thread_id: 4, is_topic_message: true };
  assert.equal(conversationKey(message, 1), 'pending:-100:4:1');
  // A reply thread in an ordinary supergroup is not a topic.
  assert.equal(conversationKey({ chat: { id: -100 }, message_thread_id: 9 }, 1), 'pending:-100:0:1');
  assert.notEqual(conversationKey(message, 1), conversationKey(message, 2));
  assert.notEqual(conversationKey(message, 1), conversationKey({ chat: { id: -100 } }, 1));
});

const chat = { id: -1001234567890, type: 'supergroup', title: 'Группа' };
const base = { message_id: 55, date: 1_700_000_000, chat };

test('extractSnapshot captures text, entities, source and URL', () => {
  const { snapshot } = extractSnapshot({
    ...base,
    from: { id: 2, first_name: 'Игорь' },
    text: 'Смотри документацию',
    entities: [{ type: 'text_link', offset: 6, length: 11, url: 'https://docs.example.com' }],
  });
  assert.equal(snapshot.body, 'Смотри документацию');
  assert.equal(snapshot.url, 'https://docs.example.com/');
  assert.equal(snapshot.source.authorId, 2);
  assert.equal(snapshot.source.url, 'https://t.me/c/1234567890/55');
  assert.deepEqual(snapshot.entities, [{ type: 'text_link', offset: 6, length: 11, url: 'https://docs.example.com' }]);
});

test('extractSnapshot keeps override text separate from the source message', () => {
  const { snapshot, warning } = extractSnapshot(
    { ...base, from: { id: 2, first_name: 'Игорь' }, text: 'Оригинал' },
    'примечание',
    '/remember текст не нужен',
  );
  assert.equal(snapshot.body, '/remember текст не нужен');
  assert.equal(snapshot.annotation, 'примечание');
  assert.deepEqual(snapshot.entities, []);
  assert.equal(warning, undefined);
  assert.equal(snapshot.source.messageId, 55);
});

test('extractSnapshot handles photos, documents and unsupported media', () => {
  const photo = extractSnapshot({
    ...base,
    from: { id: 2, first_name: 'Игорь' },
    photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'big', width: 100, height: 100 }],
    caption: 'Схема',
  });
  assert.equal(photo.snapshot.attachment.fileId, 'big');
  assert.equal(photo.snapshot.body, 'Схема');

  const document = extractSnapshot({
    ...base,
    from: { id: 2, first_name: 'Игорь' },
    document: { file_id: 'doc', file_name: 'шпаргалка.pdf', mime_type: 'application/pdf', file_size: 5 },
    caption: '',
  });
  assert.equal(document.snapshot.attachment.fileName, 'шпаргалка.pdf');
  assert.equal(document.snapshot.attachment.kind, 'document');

  const voiceOnly = extractSnapshot({ ...base, from: { id: 2, first_name: 'Игорь' }, voice: { file_id: 'v' } });
  assert.match(voiceOnly.error, /не поддерживается/);

  const videoWithCaption = extractSnapshot({
    ...base,
    from: { id: 2, first_name: 'Игорь' },
    video: { file_id: 'v' },
    caption: 'Разбор задачи',
  });
  assert.match(videoWithCaption.warning, /не поддерживается/);
  assert.equal(videoWithCaption.snapshot.body, 'Разбор задачи');
  assert.equal(videoWithCaption.snapshot.attachment, undefined);
});

test('extractSnapshot keeps channel authorship without inventing a member', () => {
  const { snapshot } = extractSnapshot({
    ...base,
    sender_chat: { id: -100777, title: 'Канал группы' },
    text: 'Анонс',
  });
  assert.equal(snapshot.source.authorName, 'Канал группы');
  assert.equal(snapshot.source.authorId, undefined);
});

test('extractSnapshot reports unavailable messages accurately', () => {
  assert.match(extractSnapshot({ ...base, date: 0, text: 'x' }).error, /недоступно/);
  assert.match(extractSnapshot({ ...base, from: { id: 2 }, text: '' }).error, /нет доступного текста/);
});

test('safeUrl allows only http(s) without credentials', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('javascript:alert(1)'), undefined);
  assert.equal(safeUrl('data:text/html,x'), undefined);
  assert.equal(safeUrl('https://user:pass@example.com'), undefined);
  assert.equal(safeUrl(42), undefined);
});

test('publicMemory hides protected file references', () => {
  const memory = {
    id: 1,
    displayId: 'M-1',
    groupId: 'group_memory',
    title: 'Заголовок',
    body: 'Тело',
    annotation: 'Примечание',
    url: '',
    tags: ['тег'],
    type: 'document',
    pinned: true,
    creator: { id: 1, name: 'Анна' },
    editor: { id: 2, name: 'Игорь' },
    createdAt: 100,
    updatedAt: 200,
    version: 3,
    trashed: true,
    deletedBy: { id: 2, name: 'Игорь' },
    source: { messageId: 5, chatId: -1001234567890, date: 1, authorName: 'Игорь' },
    attachment: {
      kind: 'document',
      fileId: 'BQAC-secret',
      fileUniqueId: 'uniq',
      fileName: 'файл.pdf',
      mimeType: 'application/pdf',
      size: 10,
      available: false,
    },
    entities: [{ type: 'bold', offset: 0, length: 4 }],
  };
  const publicItem = publicMemory(memory);
  const json = JSON.stringify(publicItem);
  assert.ok(!json.includes('BQAC-secret'));
  assert.ok(!json.includes('uniq'));
  assert.equal(publicItem.attachment.fileName, 'файл.pdf');
  assert.equal(publicItem.attachment.available, false);
  assert.equal(publicItem.source.chatId, '-1001234567890');
  assert.equal(publicItem.deletedBy.name, 'Игорь');
  assert.equal(publicMemory(null), null);
  const exported = exportMemory(memory);
  assert.match(exported.attachment.note, /не резервная копия/);
});

test('inferType picks the content type', () => {
  assert.equal(inferType({ body: 'x', url: '' }), 'text');
  assert.equal(inferType({ body: 'x', url: 'https://example.com' }), 'link');
  assert.equal(inferType({ body: 'x', attachment: { kind: 'photo' } }), 'photo');
  assert.equal(inferType({ body: 'x', attachment: { kind: 'document' } }), 'document');
});
