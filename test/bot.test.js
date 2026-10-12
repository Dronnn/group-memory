import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../tgcloud/lib/bot.js';
import { createService } from '../tgcloud/lib/service.js';
import { createFakeApi } from './helpers/fake-api.js';
import { createMemoryStore } from './helpers/memory-store.js';
import { config as baseConfig } from '../tgcloud/lib/config.js';

const CHAT = -1001234567890;
const GROUP = 'g1001234567890';
const OTHER_CHAT = -1009999999999;
const other = { id: OTHER_CHAT, type: 'supergroup', title: 'Соседи' };
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
  const config = { ...baseConfig, botUsername: 'group_memory_bot' };
  const service = createService({ store, api, config, now: () => time });
  const bot = createBot({ service, store, api, config, now: () => time });
  return { bot, api, store, service, advance: ms => (time += ms) };
}

const msg = (over = {}) => ({ message_id: 500, date: 1_700_000_000, chat, from: anna, ...over });
const ctx = updateId => ({ update: { update_id: updateId } });
const items = (store, group = GROUP) => store.list(group, { view: 'active', limit: 50, terms: [] });
const dm = (over = {}) => ({ message_id: 900, date: 1_700_000_000, chat: { id: anna.id, type: 'private' }, from: anna, ...over });
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
  assert.deepEqual(confirmation.reply_markup.inline_keyboard[0].map(b => b.text), ['Показать', 'В приложении']);
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
  await bot.message(msg({ text: '/remember', message_thread_id: 5, is_topic_message: true }), ctx(1));
  await bot.message(msg({ message_id: 501, from: igor, text: 'Заметка другого участника' }), ctx(2));
  await bot.message(msg({ message_id: 502, text: 'Чужая ветка', message_thread_id: 6, is_topic_message: true }), ctx(3));
  assert.equal((await items(store)).length, 0);
  await bot.message(msg({ message_id: 503, text: 'Заметка Анны', message_thread_id: 5, is_topic_message: true }), ctx(4));
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
  assert.match(last(api).text, /Поиск: договорённость/);
  await bot.message(msg({ message_id: 502, text: '@group_memory_bot память' }), ctx(3));
  assert.match(last(api).text, /Память группы «Учебная группа»/);
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
  await bot.message(msg({ text: '/remember В топике', message_thread_id: 42, is_topic_message: true }), ctx(1));
  assert.equal(last(api).message_thread_id, 42);
  await bot.message(msg({ message_id: 501, text: '/find в' , message_thread_id: 42, is_topic_message: true }), ctx(2));
  assert.equal(last(api).message_thread_id, 42);
});

test('/find and /recent list results with item buttons', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Деплой по пятницам' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/find деплой' }), ctx(2));
  const results = last(api);
  assert.match(results.text, /Поиск: деплой/);
  assert.equal(results.reply_markup.inline_keyboard[0][0].callback_data, 'p:g1001234567890:v:1');
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
  const trash = await store.list(GROUP, { view: 'trash', limit: 10, terms: [] });
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
  assert.equal((await store.list(GROUP, { view: 'trash', limit: 10, terms: [] })).length, 1);

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
  await bot.membership({ chat, new_chat_member: { status: 'administrator', user: { id: 777 } } });
  await bot.membership({ chat, new_chat_member: { status: 'kicked', user: { id: 777 } } });
  await bot.message(msg({ text: '/remember текст' }), ctx(1));
  assert.match(last(api).text, /Не удалось проверить участие/);
  await bot.membership({ chat, new_chat_member: { status: 'administrator', user: { id: 777 } } });
  await bot.message(msg({ message_id: 501, text: '/remember снова работает' }), ctx(2));
  assert.match(last(api).text, /^Сохранено/);
});

test('chat migration updates the stored mapping', async () => {
  const { bot, store } = setupBot();
  await bot.membership({ chat: { id: CHAT, type: 'group' }, new_chat_member: { status: 'administrator', user: { id: 777 } } });
  await bot.message({ chat: { id: CHAT, type: 'group' }, migrate_to_chat_id: -1009999999999, message_id: 1 }, ctx(1));
  const group = await store.getGroup(GROUP);
  assert.equal(group.chatId, -1009999999999);
});

test('/start file_<id> delivers attachments to the private chat', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(
    msg({ text: '/remember', reply_to_message: msg({ message_id: 10, from: igor, photo: [{ file_id: 'big', width: 100, height: 100 }], caption: 'Схема' }) }),
    ctx(1),
  );
  const id = (await items(store))[0].id;
  await bot.message({ message_id: 600, date: 1_700_000_000, chat: { id: anna.id, type: 'private' }, from: anna, text: `/start file_${GROUP}_${id}` }, ctx(2));
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
  assert.match(last(api).reply_markup.inline_keyboard[0][0].url, /startapp=g1001234567890$/);
  assert.equal(api.calls.setMyCommands, 2);
  const commands = api.sentCommands.flatMap(entry => entry.commands);
  assert.ok(commands.some(entry => entry.command === 'remember' && /Сохранить/.test(entry.description)));
  assert.ok(commands.some(entry => entry.command === 'forget'));
  await bot.message(msg({ message_id: 501, text: '/start' }), ctx(2));
  assert.equal(api.calls.setMyCommands, 2);
});

test('each group gets its own memory', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Наша тайна' }), ctx(1));
  await bot.message(msg({ chat: other, message_id: 501, text: '/remember Соседская запись' }), ctx(2));
  assert.deepEqual((await items(store)).map(row => row.data.current.body), ['Наша тайна']);
  assert.deepEqual((await items(store, 'g1009999999999')).map(row => row.data.current.body), ['Соседская запись']);
  assert.match(last(api).reply_markup.inline_keyboard[0][1].url, /startapp=g1009999999999_m_2$/);
  await bot.message(msg({ chat: other, message_id: 502, text: '/find тайна' }), ctx(3));
  assert.match(last(api).text, /ничего не найдено/);
});

test('private chat without known groups explains how to start', async () => {
  const { bot, api } = setupBot();
  await bot.message(dm({ text: '/recent' }), ctx(1));
  assert.match(last(api).text, /Не нашёл ваших групп/);
});

test('private chat with one group uses it directly', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Из группы' }), ctx(1));
  await bot.message(dm({ text: '/remember' }), ctx(2));
  assert.match(last(api).text, /Пришлите текст/);
  await bot.message(dm({ message_id: 901, text: 'Из лички' }), ctx(3));
  assert.equal((await items(store)).length, 2);
  await bot.message(dm({ message_id: 902, text: '/recent' }), ctx(4));
  assert.match(last(api).text, /Последние записи/);
});

test('private chat with several groups asks which one and replays the command', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Из первой' }), ctx(1));
  await bot.message(msg({ chat: other, message_id: 501, text: '/remember Из второй' }), ctx(2));
  await bot.message(dm({ text: '/remember Только во вторую' }), ctx(3));
  const choice = last(api);
  assert.equal(choice.text, 'Для какой группы?');
  const buttons = choice.reply_markup.inline_keyboard.map(row => row[0]);
  assert.equal(buttons.length, 2);
  const target = buttons.find(button => button.callback_data.endsWith(':g1009999999999'));
  await bot.callback({ id: 'cb-foreign', from: igor, message: { chat: { id: anna.id, type: 'private' }, message_id: 901 }, data: target.callback_data });
  assert.match(lastAnswer(api).text, /Выбор истёк/);
  await bot.callback({ id: 'cb-own', from: anna, message: { chat: { id: anna.id, type: 'private' }, message_id: 901 }, data: target.callback_data });
  assert.match(last(api).text, /^Сохранено/);
  assert.equal((await items(store)).length, 1);
  assert.deepEqual((await items(store, 'g1009999999999')).map(row => row.data.current.body), ['Из второй', 'Только во вторую'].reverse());
  await bot.callback({ id: 'cb-again', from: anna, message: { chat: { id: anna.id, type: 'private' }, message_id: 901 }, data: target.callback_data });
  assert.match(lastAnswer(api).text, /Выбор истёк/);
});

test('private chat refuses a group the user has left', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Из первой' }), ctx(1));
  await bot.message(msg({ chat: other, message_id: 501, text: '/remember Из второй' }), ctx(2));
  await bot.message(dm({ text: '/recent' }), ctx(3));
  const target = last(api).reply_markup.inline_keyboard.map(row => row[0]).find(button => button.callback_data.endsWith(':g1009999999999'));
  api.members[`${OTHER_CHAT}:${anna.id}`] = { status: 'left' };
  await bot.callback({ id: 'cb', from: anna, message: { chat: { id: anna.id, type: 'private' }, message_id: 900 }, data: target.callback_data });
  assert.match(last(api).text, /Доступ закрыт/);
  assert.equal((await items(store, 'g1009999999999')).length, 1);
});

const press = (bot, from, panelMessage, data, id = 'cb') =>
  bot.callback({ id, from, message: { chat: panelMessage.chat, message_id: panelMessage.message_id }, data });
const panelOf = api => {
  const sent = api.sent.filter(entry => entry.method === 'sendMessage').at(-1);
  return { chat: { id: sent.chat_id }, message_id: api.sent.indexOf(sent) + 1 };
};
const lastEdit = api => api.sent.filter(entry => entry.method === 'editMessageText').at(-1);
const buttonData = (view, text) => view.reply_markup.inline_keyboard.flat().find(button => button.text === text)?.callback_data;

test('/memory opens a panel that navigates in place', async () => {
  const { bot, api } = setupBot();
  await bot.message(msg({ text: '/remember Деплой по пятницам\nподробности здесь' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/memory' }), ctx(2));
  const menu = last(api);
  assert.match(menu.text, /Память группы «Учебная группа»/);
  assert.deepEqual(menu.reply_markup.inline_keyboard.flat().map(button => button.text), ['Последние', 'Поиск', 'Теги', 'Корзина', 'Добавить', 'Приложение']);
  const panel = panelOf(api);
  const sentBefore = api.calls.sendMessage;

  await press(bot, anna, panel, buttonData(menu, 'Последние'));
  const list = lastEdit(api);
  assert.equal(list.message_id, panel.message_id);
  assert.match(list.text, /Последние записи\n\nM-1 · Деплой по пятницам/);

  await press(bot, igor, panel, list.reply_markup.inline_keyboard[0][0].callback_data);
  const card = lastEdit(api);
  assert.match(card.text, /подробности здесь/);
  assert.match(card.text, /Сохранил\(а\): Анна/);
  assert.deepEqual(card.reply_markup.inline_keyboard.flat().map(button => button.text), ['Изменить', 'Теги', 'В корзину', 'Открыть в приложении', 'Меню']);

  await press(bot, anna, panel, buttonData(card, 'Меню'));
  assert.match(lastEdit(api).text, /Память группы/);
  assert.equal(api.calls.sendMessage, sentBefore, 'navigation never posts new messages');
});

test('lists page with "Ещё" and stop at the end', async () => {
  const { bot, api, advance } = setupBot();
  for (let i = 1; i <= 10; i += 1) {
    await bot.message(msg({ message_id: 600 + i, text: `/remember Запись ${i}` }), ctx(i));
    advance(1000);
  }
  await bot.message(msg({ message_id: 700, text: '/recent' }), ctx(20));
  const first = last(api);
  assert.equal(first.reply_markup.inline_keyboard.length, 9);
  const more = buttonData(first, 'Ещё');
  assert.ok(more.length <= 64);
  await press(bot, anna, panelOf(api), more);
  const second = lastEdit(api);
  assert.match(second.text, /Запись 2\nM-1 · Запись 1/);
  assert.equal(buttonData(second, 'Ещё'), undefined);
});

test('/show displays a card; trash asks first, restore brings it back', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Важное правило' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/show 1' }), ctx(2));
  const card = last(api);
  assert.match(card.text, /M-1 · Важное правило/);
  const panel = panelOf(api);
  await press(bot, anna, panel, buttonData(card, 'В корзину'));
  const confirmView = lastEdit(api);
  assert.match(confirmView.text, /Переместить в корзину/);
  assert.equal((await items(store)).length, 1);
  await press(bot, anna, panel, buttonData(confirmView, 'В корзину'), 'cb-trash');
  const trashed = lastEdit(api);
  assert.match(trashed.text, /В корзине/);
  assert.equal((await items(store)).length, 0);
  await press(bot, igor, panel, buttonData(trashed, 'Восстановить'), 'cb-restore');
  assert.equal((await items(store)).length, 1);
  assert.equal(buttonData(lastEdit(api), 'Восстановить'), undefined);

  await bot.message(msg({ message_id: 502, text: '/show 99' }), ctx(3));
  assert.match(last(api).text, /Запись не найдена/);
});

test('a stale trash confirmation redraws the current card', async () => {
  const { bot, api, service } = setupBot();
  await bot.message(msg({ text: '/remember Текст' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/show 1' }), ctx(2));
  const panel = panelOf(api);
  await press(bot, anna, panel, buttonData(last(api), 'В корзину'));
  const confirmData = buttonData(lastEdit(api), 'В корзину');
  await service.execute('update', { group: GROUP, id: 1, expectedVersion: 1, requestId: 'req-00000099', body: 'Новый текст' }, igor);
  await press(bot, anna, panel, confirmData, 'cb-stale');
  assert.match(lastEdit(api).text, /Новый текст/);
  assert.doesNotMatch(lastEdit(api).text, /В корзине/);
});

test('tags open their items', async () => {
  const { bot, api, service } = setupBot();
  await service.registerChat(chat);
  await service.execute('create', { group: GROUP, requestId: 'req-00000001', body: 'Про деплой', tags: ['деплой'] }, anna);
  await service.execute('create', { group: GROUP, requestId: 'req-00000002', body: 'Про тесты', tags: ['тесты'] }, anna);
  await bot.message(msg({ text: '/tags' }), ctx(1));
  const tags = last(api);
  assert.deepEqual(tags.reply_markup.inline_keyboard.flat().map(button => button.text), ['#деплой', '#тесты', 'Меню']);
  await press(bot, anna, panelOf(api), buttonData(tags, '#тесты'));
  const list = lastEdit(api);
  assert.match(list.text, /^#тесты\n\nM-2/);
  assert.doesNotMatch(list.text, /деплой/);
});

test('panel search and add take a reply to the panel', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/memory' }), ctx(1));
  const menu = last(api);
  const panel = panelOf(api);
  await press(bot, anna, panel, buttonData(menu, 'Добавить'));
  assert.match(lastEdit(api).text, /Ответьте на это сообщение/);
  await bot.message(msg({ message_id: 501, text: 'Заметка из меню', reply_to_message: { message_id: panel.message_id, chat, from: { id: 777, is_bot: true } } }), ctx(2));
  assert.equal((await items(store))[0].data.current.body, 'Заметка из меню');

  await press(bot, anna, panel, buttonData(menu, 'Поиск'));
  await bot.message(msg({ message_id: 502, text: 'меню' }), ctx(3));
  assert.match(last(api).text, /Поиск: меню\n\nM-1/);

  await press(bot, anna, panel, buttonData(menu, 'Добавить'));
  await press(bot, anna, panel, buttonData(lastEdit(api), 'Отмена'));
  await bot.message(msg({ message_id: 503, text: 'Это уже не заметка' }), ctx(4));
  assert.equal((await items(store)).length, 1);
});

test('search paging keeps the query', async () => {
  const { bot, api, advance } = setupBot();
  for (let i = 1; i <= 9; i += 1) {
    await bot.message(msg({ message_id: 600 + i, text: `/remember Деплой ${i}` }), ctx(i));
    advance(1000);
  }
  await bot.message(msg({ message_id: 700, text: '/remember Другое' }), ctx(20));
  await bot.message(msg({ message_id: 701, text: '/find деплой' }), ctx(21));
  await press(bot, anna, panelOf(api), buttonData(last(api), 'Ещё'));
  assert.match(lastEdit(api).text, /^Поиск: деплой\n\nM-1 · Деплой 1$/);
});

test('outsiders cannot use someone else\'s panel', async () => {
  const { bot, api } = setupBot();
  api.members['*:3'] = { status: 'left' };
  await bot.message(msg({ text: '/memory' }), ctx(1));
  const edits = api.calls.editMessageText;
  await press(bot, { id: 3, first_name: 'Чужой' }, panelOf(api), buttonData(last(api), 'Последние'));
  assert.match(lastAnswer(api).text, /Доступ закрыт/);
  assert.equal(api.calls.editMessageText, edits);
});

test('prompts force a reply and any first command registers the menu', async () => {
  const { bot, api } = setupBot();
  await bot.message(msg({ text: '/remember' }), ctx(1));
  assert.equal(api.calls.setMyCommands, 2);
  assert.deepEqual(last(api).reply_markup, { force_reply: true, selective: true });
  assert.equal(last(api).reply_parameters.message_id, 500);
  assert.ok(api.sentCommands[0].commands.some(entry => entry.command === 'show'));
});

test('a reply thread in an ordinary supergroup still completes pending input', async () => {
  const { bot, store } = setupBot();
  await bot.message(msg({ text: '/remember' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: 'Ответ в ветке', message_thread_id: 500 }), ctx(2));
  assert.equal((await items(store))[0].data.current.body, 'Ответ в ветке');
});

const current = async store => (await items(store))[0].data.current;

test('hashtags at the edges of own text become tags and leave the text', async () => {
  const { bot, store } = setupBot();
  await bot.message(msg({ text: '/remember #деплой Деплой по пятницам #Правила #CI_CD' }), ctx(1));
  const saved = await current(store);
  assert.equal(saved.body, 'Деплой по пятницам');
  assert.equal(saved.title, 'Деплой по пятницам');
  assert.deepEqual(saved.tags, ['деплой', 'правила', 'ci_cd']);
});

test('a hashtag inside the text stays there and is also a tag', async () => {
  const { bot, store } = setupBot();
  await bot.message(msg({ text: '/remember Для #деплой нужен доступ #срочно' }), ctx(1));
  const saved = await current(store);
  assert.equal(saved.body, 'Для #деплой нужен доступ');
  assert.deepEqual(saved.tags, ['деплой', 'срочно']);
});

test('the original message keeps its hashtags; command hashtags are tags, not an annotation', async () => {
  const { bot, store } = setupBot();
  const source = msg({ message_id: 10, from: igor, text: '#вакансия Ищем айос разработчика' });
  await bot.message(msg({ text: '/save #важное', reply_to_message: source }), ctx(1));
  const saved = await current(store);
  assert.equal(saved.body, '#вакансия Ищем айос разработчика');
  assert.equal(saved.annotation, '');
  assert.deepEqual(saved.tags, ['важное', 'вакансия']);
});

test('/remember with only hashtags waits for content and tags it', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember #рецепт' }), ctx(1));
  assert.match(last(api).text, /с тегами #рецепт/);
  await bot.message(msg({ message_id: 501, text: 'Борщ по-домашнему', entities: [{ type: 'bold', offset: 0, length: 4 }] }), ctx(2));
  const saved = await current(store);
  assert.equal(saved.body, 'Борщ по-домашнему');
  assert.deepEqual(saved.tags, ['рецепт']);
});

test('formatting survives cutting edge hashtags from pending input', async () => {
  const { bot, store } = setupBot();
  await bot.message(msg({ text: '/remember' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '#код Пример цикла', entities: [{ type: 'hashtag', offset: 0, length: 4 }, { type: 'bold', offset: 5, length: 6 }] }), ctx(2));
  const saved = await current(store);
  assert.equal(saved.body, 'Пример цикла');
  assert.deepEqual(saved.entities, [{ type: 'bold', offset: 0, length: 6 }]);
});

test('/tag replaces tags; the card button asks for a reply', async () => {
  const { bot, api, store } = setupBot();
  await bot.message(msg({ text: '/remember Заметка #старое' }), ctx(1));
  await bot.message(msg({ message_id: 501, text: '/tag 1 #новое #ещё' }), ctx(2));
  assert.deepEqual((await current(store)).tags, ['новое', 'ещё']);
  assert.match(last(api).text, /^Теги: #новое #ещё/);
  await bot.message(msg({ message_id: 502, text: '/tag 1 -' }), ctx(3));
  assert.deepEqual((await current(store)).tags, []);

  await bot.message(msg({ message_id: 503, text: '/show 1' }), ctx(4));
  const panel = panelOf(api);
  await press(bot, anna, panel, buttonData(last(api), 'Теги'));
  assert.match(lastEdit(api).text, /Пришлите хэштеги для M-1/);
  await bot.message(msg({ message_id: 504, text: 'без тегов' }), ctx(5));
  assert.match(last(api).text, /Не нашёл хэштегов/);
  await bot.message(msg({ message_id: 505, text: '#финал' }), ctx(6));
  assert.deepEqual((await current(store)).tags, ['финал']);
});

test('too many or too long hashtags are capped, never fail the save', async () => {
  const { bot, store } = setupBot();
  const many = Array.from({ length: 12 }, (_, i) => `#тег${i}`).join(' ');
  await bot.message(msg({ text: `/remember Текст ${many} #${'д'.repeat(31)}` }), ctx(1));
  const saved = await current(store);
  assert.equal(saved.body, 'Текст');
  assert.equal(saved.tags.length, 10);
});
