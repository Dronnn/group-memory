import { appLink } from './commands.js';

// In-chat views: each returns {text, keyboard} for one message that is edited in place.
// Callback data: p:<group>:<view>[:args] — the group travels with the button, so panels
// work in private chats too; every press re-authorizes the presser through the service.
export const PAGE_SIZE = 8;
const TAGS_SHOWN = 40;
const TEXT_LIMIT = 4000;

export const panelData = (group, ...parts) => ['p', group, ...parts].join(':');
const line = item => `${item.displayId || 'M-' + item.id} · ${item.title}`;
const date = ms => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
};
const clip = (text, max) => (text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text);

export function createPanel({ service, username }) {
  const app = selector => appLink(username(), selector);
  const menuButton = group => ({ text: 'Меню', callback_data: panelData(group, 'm') });

  async function menu(actor, group) {
    const { group: info } = await service.authorize(actor, group);
    return {
      text: `Память группы «${info.title}»\n\nСохранить: /remember текст или /remember ответом на сообщение.\nНайти: «Поиск» или /find запрос.`,
      keyboard: [
        [{ text: 'Последние', callback_data: panelData(group, 'r') }, { text: 'Поиск', callback_data: panelData(group, 's') }],
        [{ text: 'Теги', callback_data: panelData(group, 't') }, { text: 'Корзина', callback_data: panelData(group, 'x') }],
        [{ text: 'Добавить', callback_data: panelData(group, 'a') }, { text: 'Приложение', url: app(group) }],
      ],
    };
  }

  // `more` is the callback prefix that reopens this list at the next cursor.
  async function page(actor, group, { title, empty, filter, cursor, more }) {
    const result = await service.execute('list', { group, ...filter, sort: 'newest', pageSize: PAGE_SIZE, cursor }, actor);
    if (!result.items.length) return { text: cursor ? `${title}\n\nБольше записей нет.` : empty, keyboard: [[menuButton(group)]] };
    const nav = [];
    if (result.nextCursor) nav.push({ text: 'Ещё', callback_data: panelData(group, ...more, result.nextCursor) });
    nav.push(menuButton(group));
    return {
      text: clip(`${title}\n\n${result.items.map(line).join('\n')}`, TEXT_LIMIT),
      keyboard: [...result.items.map(item => [{ text: clip(line(item), 60), callback_data: panelData(group, 'v', item.id) }]), nav],
    };
  }

  const recent = (actor, group, cursor) =>
    page(actor, group, { title: 'Последние записи', empty: 'Пока пусто. Сохраните первую запись: /remember текст', filter: {}, cursor, more: ['r'] });
  const trash = (actor, group, cursor) =>
    page(actor, group, { title: 'Корзина', empty: 'Корзина пуста.', filter: { view: 'trash' }, cursor, more: ['x'] });
  const search = (actor, group, query, cursor) =>
    page(actor, group, { title: `Поиск: ${clip(query, 100)}`, empty: `По запросу «${clip(query, 100)}» ничего не найдено.`, filter: { query }, cursor, more: ['f'] });

  async function tags(actor, group) {
    const { tags: all } = await service.execute('tags', { group }, actor);
    if (!all.length) return { text: 'Тегов пока нет. Добавьте хэштег при сохранении: /remember текст #тег', keyboard: [[menuButton(group)]] };
    const shown = all.slice(0, TAGS_SHOWN);
    const rows = [];
    for (let i = 0; i < shown.length; i += 2) {
      rows.push(shown.slice(i, i + 2).map((tag, j) => ({ text: `#${tag}`, callback_data: panelData(group, 'T', i + j) })));
    }
    rows.push([menuButton(group)]);
    return { text: all.length > shown.length ? `Теги (первые ${TAGS_SHOWN} из ${all.length})` : 'Теги', keyboard: rows };
  }

  // Tags are addressed by position in the sorted list to fit Telegram's 64-byte callback limit.
  async function tagItems(actor, group, index, cursor) {
    const { tags: all } = await service.execute('tags', { group }, actor);
    const tag = all[index];
    if (!tag) return tags(actor, group);
    return page(actor, group, { title: `#${tag}`, empty: `С тегом #${tag} записей нет.`, filter: { tag }, cursor, more: ['T', index] });
  }

  function cardView(group, item) {
    const head = [line(item), ...(item.trashed ? ['В корзине'] : [])].join('\n');
    const foot = [];
    if (item.annotation) foot.push(`Примечание: ${clip(item.annotation, 1000)}`);
    if (item.url) foot.push(`Ссылка: ${item.url}`);
    if (item.attachment) {
      const name = item.attachment.kind === 'photo' ? 'фото' : item.attachment.fileName || 'документ';
      foot.push(`Вложение: ${name}${item.attachment.available === false ? ' (недоступно)' : ''}`);
    }
    if (item.tags.length) foot.push(`Теги: ${item.tags.map(tag => '#' + tag).join(' ')}`);
    foot.push(`Сохранил(а): ${item.creator.name}, ${date(item.createdAt)}`);
    if (item.version > 1) foot.push(`Изменил(а): ${item.editor.name}, ${date(item.updatedAt)}`);
    if (item.source?.authorName) foot.push(`Автор сообщения: ${item.source.authorName}`);
    if (item.source?.url) foot.push(`Оригинал: ${item.source.url}`);
    const footText = foot.join('\n');
    const body = clip(item.body, TEXT_LIMIT - head.length - footText.length - 4);
    const keyboard = [
      item.trashed
        ? [{ text: 'Восстановить', callback_data: panelData(group, 'R', item.id, item.version) }]
        : [
            { text: 'Изменить', callback_data: panelData(group, 'e', item.id, item.version) },
            { text: 'Теги', callback_data: panelData(group, 'k', item.id) },
            { text: 'В корзину', callback_data: panelData(group, 'd', item.id, item.version) },
          ],
    ];
    if (item.attachment && item.attachment.available !== false) {
      keyboard.push([{ text: 'Получить файл в личку', url: `https://t.me/${username()}?start=file_${group}_${item.id}` }]);
    }
    keyboard.push([{ text: 'Открыть в приложении', url: app(`${group}_m_${item.id}`) }, menuButton(group)]);
    return { text: [head, body, footText].filter(Boolean).join('\n\n'), keyboard };
  }

  async function card(actor, group, id) {
    return cardView(group, await service.execute('read', { group, id }, actor));
  }

  async function confirmTrash(actor, group, id) {
    const item = await service.execute('read', { group, id }, actor);
    if (item.trashed) return cardView(group, item);
    return {
      text: `Переместить в корзину ${line(item)}?\n\nИз корзины запись можно восстановить.`,
      keyboard: [[
        { text: 'В корзину', callback_data: panelData(group, 'D', item.id, item.version) },
        { text: 'Отмена', callback_data: panelData(group, 'v', item.id) },
      ]],
    };
  }

  return { menu, recent, trash, search, tags, tagItems, card, confirmTrash };
}
