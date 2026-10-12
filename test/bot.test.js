import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../tgcloud/lib/bot.js';
import { createService } from '../tgcloud/lib/service.js';
import { createFakeApi } from './helpers/fake-api.js';
import { createMemoryStore } from './helpers/memory-store.js';
import { config as baseConfig } from '../tgcloud/lib/config.js';

const CHAT = -1001234567890;
const anna = { id: 1, first_name: 'Анна', is_bot: false };
const igor = { id: 2, first_name: 'Игорь', is_bot: false };
const chat = { id: CHAT, type: 'supergroup', title: 'Учебная группа' };

function setupBot(apiOptions = {}) {
  let time = 1_700_000_000_000;
  const store = createMemoryStore();
  const api = createFakeApi({
    members: { [`*:${anna.id}`]: { status: 'member' }, [`*:${igor.id}`]: { status: 'member' } },
    ...apiOptions,
  });
  const config = { ...baseConfig, initialChatId: CHAT, botUsername: 'group_memory_bot' };
  const service = createService({ store, api, config, now: () => time });
  const bot = createBot({ service, store, api, config, now: () => time });
  return { bot, api, store, service, advance: ms => (time += ms), groupId: 'group_memory' };
}

const msg = (over = {}) => ({ message_id: 500, date: 1_700_000_000, chat, from: anna, ...over });
const ctx = updateId => ({ update: { update_id: updateId } });
const items = store => store.list('group_memory', { view: 'active', limit: 50, terms: [] });
const last = api => api.sent.at(-1);
const lastAnswer = api => api.sent.filter(entry => entry.method === 'answerCallbackQuery').at(-1);

test('replying /remember saves exactly the selected message', async () => {
  const { bot, api, store } = setupBot();
  const source = msg({ message_id: 10, from: igor, text: 'Как настроить деплой приложения' });
  await bot.message(msg({ message_id: 11, text: '/remember', reply_to_message: source }), ctx(1));
  const saved = await items(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.current.body, 'Как настроить деплой приложения');
  assert.equal(saved[0].data.current.annotation, '');
  assert.equal(saved[0].data.current.creator.name, 'Анна');
  assert.equal(saved[0].data.current.source.authorName, 'Игорь');
  assert.equal(saved[0].data.current.source.messageId, 10);
  const confirmation = last(api);
  assert.match(confirmation.text, /^Сохранено/);
  assert.match(confirmation.text, /M-1/);
  assert.deepEqual(confirmation.reply_markup.inline_keyboard[0].map(b => b.text), ['Открыть', 'Изменить']);
});

test('command text becomes a separate annotation, original content is preserved', async () => {
  const { bot, store } = setupBot();
  const source = msg({ message_id: 10, from: igor, text: 'Ссылка на документацию' , entities: [{ type: 'url', offset: 0, length: 5 }] });
  await bot.message(msg({ text: '/remember это нам пригодится', reply_to_message: source }), ctx(1));
  const saved = await items(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.current.body, 'Ссылка на документацию');
  assert.equal(saved[0].data.current.annotation, 'это нам пригодится');
  assert.equal(saved[0].data.current.entities.length, 1);
});

test('re-saving one source message returns the existing memory', async () => {
  const { bot, api, store } = setupBot();
  const source = msg({ message_id: 10, from: igor, text: 'Повторная запись' });
  await bot.message(msg({ text: '/remember', reply_to_message: source }), ctx(1));
  await bot.message(msg({ message_id: 12, text: '/save', reply_to_message: source }), ctx(2));
  assert.match(last(api).text, /^Уже сохранено/);
  assert.equal((await items(store)).length, 1);
});

test('/remember text saves a standalone note', async () => {
  const { bot, store } = setupBot();
  await bot.message(msg({ text: '/remember Встречаемся по четвергам в 19:00.' }), ctx(1));
  const saved = await items(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.current.body, 'Встречаемся по четвергам в 19:00.');
  assert.equal(saved[0].data.current.creator.name, 'Анна');
  assert.equal(saved[0].data.current.source.messageId, 500);
});

test('/remember without content guides to the next message and saves it', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember' }), ctx(1));
  assert.match(last(api).text, /Пришлите текст/);
  await bot.message(msg({ message_id: 501, text: 'Правило: деплой по пятницам' }), ctx(2));
  const saved = await items(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.current.body, 'Правило: деплой по пятницам');
  assert.match(last(api).text, /^Сохранено/);
});

test('pending input belongs to one member and one topic', async () => {
  const { bot, store } = setupBot();
  await bot.message(msg({ text: '/remember', message_thread_id: 5 }), ctx(1));
  await bot.message(msg({ message_id: 501, from: igor, text: 'Заметка другого участника' }), ctx(2));
  await bot.message(msg({ message_id: 502, text: 'Чужая ветка', message_thread_id: 6 }), ctx(3));
  assert.equal((await items(store)).length, 0);
  await bot.message(msg({ message_id: 503, text: 'Заметка Анны', message_thread_id: 5 }), ctx(4));
  const saved = await items(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.current.body, 'Заметка Анны');
});

test('/cancel drops pending input', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/cancel' }), ctx(2));
  assert.match(last(api).text, /Ввод отменён/);
  await bot.message(msg({ message_id: 502, text: 'Это уже обычное сообщение' }), ctx(3));
  assert.equal((await items(store)).length, 0);
});

test('ordinary conversation is never archived', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: 'Привет, как дела?' }), ctx(1));
  await bot.message(msg({ message_id: 501, from: igor, text: 'https://example.com полезная статья' }), ctx(2));
  assert.equal((await items(store)).length, 0);
  assert.equal(api.calls.sendMessage, 0);
  assert.equal(api.calls.getChatMember, 0);
});

test('commands addressed to another bot are ignored', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember@other_bot текст' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/find@other_bot запрос' }), ctx(2));
  assert.equal((await items(store)).length, 0);
  assert.equal(api.calls.sendMessage, 0);
});

test('addressed natural-language shortcuts work without an LLM', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '@group_memory_bot запомни Полезная договорённость' }), ctx(1));
  assert.equal((await items(store)).length, 1);
  await bot.message(msg({ message_id: 501, text: '@group_memory_bot найди договорённость' }), ctx(2));
  assert.match(last(api).text, /Результаты поиска/);
  await bot.message(msg({ message_id: 502, text: '@group_memory_bot память' }), ctx(3));
  assert.match(last(api).text, /Память нашей группы/);
});

test('anonymous senders are guided to the Mini App instead of saving', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ from: undefined, sender_chat: { id: -100, title: 'Канал' }, text: '/remember текст' }), ctx(1));
  assert.match(last(api).text, /Mini App/);
  assert.equal((await items(store)).length, 0);
});

test('unsupported media is explained, captions can be saved as text', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember', reply_to_message: msg({ message_id: 10, from: igor, voice: { file_id: 'v1' } }) }), ctx(1));
  assert.match(last(api).text, /не поддерживается/);
  assert.equal((await items(store)).length, 0);

  await bot.message(
    msg({ message_id: 11, text: '/remember', reply_to_message: msg({ message_id: 12, from: igor, video: { file_id: 'v2' }, caption: 'Видео с разбором' }) }),
    ctx(2),
  );
  const saved = await items(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.current.body, 'Видео с разбором');
  assert.equal(saved[0].data.current.attachment, undefined);
  assert.match(last(api).text, /не поддерживается/);
});

test('photos and documents keep attachment metadata', async () => {
  const { bot, store } = setupBot();
  await bot.message(
    msg({
      text: '/remember',
      reply_to_message: msg({ message_id: 10, from: igor, photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'big', width: 100, height: 100 }], caption: 'Схема' }),
    }),
    ctx(1),
  );
  const saved = await items(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.current.attachment.kind, 'photo');
  assert.equal(saved[0].data.current.attachment.fileId, 'big');
  assert.equal(saved[0].data.current.body, 'Схема');
});

test('group replies stay in the originating topic', async () => {
  const { bot, api } = setupBot();
  await bot.message(msg({ text: '/remember В топике', message_thread_id: 42 }), ctx(1));
  assert.equal(last(api).message_thread_id, 42);
  await bot.message(msg({ message_id: 501, text: '/find в' , message_thread_id: 42 }), ctx(2));
  assert.equal(last(api).message_thread_id, 42);
});

test('/find and /recent list results with item buttons', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Деплой по пятницам' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/find деплой' }), ctx(2));
  const results = last(api);
  assert.match(results.text, /Результаты поиска/);
  assert.equal(results.reply_markup.inline_keyboard[0][0].url, 'https://t.me/group_memory_bot?startapp=m_1');
  await bot.message(msg({ message_id: 502, text: '/recent' }), ctx(3));
  assert.match(last(api).text, /Последние записи/);
  await bot.message(msg({ message_id: 503, text: '/tags' }), ctx(4));
  assert.equal(store !== null, true);
});

test('/edit and /forget confirmations act on the intended item and actor only', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Исходный текст' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/edit 1' }), ctx(2));
  assert.match(last(api).text, /Пришлите новый текст/);
  await bot.message(msg({ message_id: 502, text: 'Обновлённый текст' }), ctx(3));
  assert.match(last(api).text, /^Изменено/);

  await bot.message(msg({ message_id: 503, text: '/forget 1' }), ctx(4));
  const keyboard = last(api).reply_markup.inline_keyboard;
  assert.equal(keyboard[0][0].text, 'В корзину');
  const token = keyboard[0][0].callback_data.slice(2);

  await bot.callback({ id: 'cb-foreign', from: igor, message: { chat, message_id: 503 }, data: `c:${token}` });
  assert.match(last(api).text, /истекло или отменено/);
  const stillActive = await items(store);
  assert.equal(stillActive.length, 1);

  await bot.callback({ id: 'cb-own', from: anna, message: { chat, message_id: 503 }, data: `c:${token}` });
  assert.equal(lastAnswer(api).text, 'Перемещено в корзину');
  assert.match(last(api).text, /^В корзине/);
  const trash = await store.list('group_memory', { view: 'trash', limit: 10, terms: [] });
  assert.equal(trash.length, 1);
});

test('expired confirmations are refused and restore works for any member', async () => {
  const { bot, api, store, advance } = setupBot();
  await bot.message(msg({ text: '/remember Текст' }), ctx(1));
  const id = (await items(store))[0].id;
  await bot.message(msg({ message_id: 501, text: `/forget ${id}` }), ctx(2));
  const token = last(api).reply_markup.inline_keyboard[0][0].callback_data.slice(2);
  advance(6 * 60 * 1000);
  await bot.callback({ id: 'cb1', from: anna, message: { chat, message_id: 501 }, data: `c:${token}` });
  assert.match(last(api).text, /истекло или отменено/);

  await bot.message(msg({ message_id: 502, text: `/forget ${id}` }), ctx(3));
  const trashToken = last(api).reply_markup.inline_keyboard[0][0].callback_data.slice(2);
  await bot.callback({ id: 'cb2', from: anna, message: { chat, message_id: 502 }, data: `c:${trashToken}` });
  assert.equal((await store.list('group_memory', { view: 'trash', limit: 10, terms: [] })).length, 1);

  await bot.message(msg({ message_id: 503, from: igor, text: `/restore ${id}` }), ctx(4));
  const restoreToken = last(api).reply_markup.inline_keyboard[0][0].callback_data.slice(2);
  await bot.callback({ id: 'cb3', from: igor, message: { chat, message_id: 503 }, data: `c:${restoreToken}` });
  assert.equal(lastAnswer(api).text, 'Восстановлено');
  assert.equal((await items(store)).length, 1);
});

test('membership failures produce a useful message, not access', async () => {
  const { bot, api } = setupBot();
  api.members['*:3'] = { status: 'left' };
  await bot.message(msg({ from: { id: 3, first_name: 'Чужой' }, text: '/remember текст' }), ctx(1));
  assert.match(last(api).text, /Доступ закрыт/);
});

test('bot removal suspends bot access until restored', async () => {
  const { bot, api } = setupBot();
  await bot.membership({ chat, new_chat_member: { status: 'kicked', user: { id: 777 } } });
  await bot.message(msg({ text: '/remember текст' }), ctx(1));
  assert.match(last(api).text, /Не удалось проверить участие/);
  await bot.membership({ chat, new_chat_member: { status: 'administrator', user: { id: 777 } } });
  await bot.message(msg({ message_id: 501, text: '/remember снова работает' }), ctx(2));
  assert.match(last(api).text, /^Сохранено/);
});

test('chat migration updates the stored mapping', async () => {
  const { bot, store } = setupBot();
  await bot.message({ chat: { id: CHAT, type: 'group' }, migrate_to_chat_id: -1009999999999, message_id: 1 }, ctx(1));
  const group = await store.getGroup('group_memory');
  assert.equal(group.chatId, -1009999999999);
});

test('/start file_<id> delivers attachments to the private chat', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(
    msg({ text: '/remember', reply_to_message: msg({ message_id: 10, from: igor, photo: [{ file_id: 'big', width: 100, height: 100 }], caption: 'Схема' }) }),
    ctx(1),
  );
  const id = (await items(store))[0].id;
  await bot.message({ message_id: 600, date: 1_700_000_000, chat: { id: anna.id, type: 'private' }, from: anna, text: `/start file_${id}` }, ctx(2));
  const photo = api.sent.find(entry => entry.method === 'sendPhoto');
  assert.ok(photo, 'attachment delivered');
  assert.equal(photo.photo, 'big');
  assert.match(last(api).text, /Файл отправлен в этот чат/);
});

test('/start explains the bot, offers the entrance and registers commands', async () => {
  const { bot, api } = setupBot();
  await bot.message(msg({ text: '/start' }), ctx(1));
  assert.match(last(api).text, /Общая память группы/);
  assert.equal(last(api).reply_markup.inline_keyboard[0][0].text, 'Открыть память');
  assert.match(last(api).reply_markup.inline_keyboard[0][0].url, /startapp=g$/);
  assert.equal(api.calls.setMyCommands, 2);
  const commands = api.sentCommands.flatMap(entry => entry.commands);
  assert.ok(commands.some(entry => entry.command === 'remember' && /Сохранить/.test(entry.description)));
  assert.ok(commands.some(entry => entry.command === 'forget'));
  await bot.message(msg({ message_id: 501, text: '/start' }), ctx(2));
  assert.equal(api.calls.setMyCommands, 2);
});
