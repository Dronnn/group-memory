import { createAuth } from './auth.js';
import { AppError, fail } from './errors.js';

function isBotApiError(error) {
  return Boolean(error && (error.name === 'BotApiError' || error.method || error.description));
}
import { buildSearchText, searchTerms } from './search.js';
import { exportMemory, inferType, publicMemory, publicRevision } from './public.js';
import {
  content,
  decodeCursor,
  encodeCursor,
  pageSize,
  positiveInt,
  requestId,
} from './validation.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceKeyOf(source) {
  if (!source?.messageId || source.chatId == null) return null;
  return `${source.chatId}:${source.messageId}`;
}

function historyEntry(event, memory, at) {
  return {
    version: memory.version,
    editor: memory.editor,
    at,
    event,
    snapshot: clone(memory),
  };
}

function assertAggregateSize(data, limits) {
  const bytes = JSON.stringify(data).length;
  if (bytes > limits.aggregateBytes) {
    fail('HISTORY_LIMIT', 'Достигнут лимит размера записи. Изменение не выполнено');
  }
}

function trimApplied(applied, limits) {
  if (applied.length <= limits.appliedReceipts) return applied;
  return applied.slice(applied.length - limits.appliedReceipts);
}

function findApplied(data, id) {
  return (data.applied || []).includes(id);
}

function memoryFromRow(row) {
  const memory = row.data.current;
  memory.id = row.id;
  memory.displayId = `M-${row.id}`;
  memory.groupId = row.group_id || row.groupId || memory.groupId;
  return memory;
}

export function createService({ store, api, config, now = () => Date.now(), auth: authOverride }) {
  const auth = authOverride || createAuth({ store, api, now });
  const limits = config.limits;

  async function authorize(actor, groupId) {
    return auth.requireMember(actor, groupId);
  }

  function buildCurrent({ groupId, fields, actor, source, attachment, entities, at, version = 1, pinned = false, trashed = false, deletedBy }) {
    return {
      groupId,
      title: fields.title,
      body: fields.body,
      annotation: fields.annotation || '',
      url: fields.url || '',
      tags: fields.tags,
      type: inferType({ body: fields.body, url: fields.url, attachment }),
      pinned,
      trashed,
      creator: actor,
      editor: actor,
      createdAt: at,
      updatedAt: at,
      version,
      ...(deletedBy ? { deletedBy } : {}),
      ...(source ? { source } : {}),
      ...(attachment ? { attachment: { ...attachment, available: attachment.available !== false } } : {}),
      ...(entities?.length ? { entities } : {}),
    };
  }

  function wrapAggregate(current, history, applied, searchText) {
    return { current, history, applied, searchText };
  }

  async function insertMemory(groupId, createKey, sourceKey, data) {
    assertAggregateSize(data, limits);
    const inserted = await store.insert(groupId, createKey, sourceKey, data);
    if (inserted) {
      const memory = memoryFromRow(inserted);
      return { item: publicMemory(memory), duplicate: false, internal: memory, row: inserted };
    }
    const existing = await store.findCreate(groupId, createKey, sourceKey);
    if (!existing) fail('TEMPORARY', 'Не удалось сохранить запись. Повторите попытку');
    return {
      item: publicMemory(memoryFromRow(existing)),
      duplicate: true,
      internal: memoryFromRow(existing),
      row: existing,
    };
  }

  async function casUpdate(groupId, id, expectedVersion, mutate) {
    const row = await store.get(groupId, id);
    if (!row) fail('NOT_FOUND', 'Запись не найдена');
    const data = clone(row.data);
    const current = memoryFromRow({ ...row, data });
    if (current.version !== expectedVersion) {
      fail('CONFLICT', 'Запись уже изменена', { latest: publicMemory(current) });
    }
    const next = mutate(data, current);
    assertAggregateSize(next, limits);
    if ((next.history || []).length > limits.history) {
      fail('HISTORY_LIMIT', 'Достигнут лимит истории. Изменение не выполнено');
    }
    const updated = await store.cas(groupId, id, expectedVersion, next);
    if (!updated) {
      const latest = await store.get(groupId, id);
      fail('CONFLICT', 'Запись уже изменена', {
        latest: latest ? publicMemory(memoryFromRow(latest)) : undefined,
      });
    }
    return publicMemory(memoryFromRow(updated));
  }

  async function createFromFields(groupId, actor, fields, options) {
    const at = now();
    const createKey = options.createKey;
    const sourceKey = options.sourceKey || null;
    const current = buildCurrent({
      groupId,
      fields,
      actor,
      source: options.source,
      attachment: options.attachment,
      entities: options.entities,
      at,
    });
    current.id = 0;
    current.displayId = 'M-0';
    const history = [historyEntry('create', current, at)];
    const applied = [options.requestId];
    const data = wrapAggregate(current, history, applied, buildSearchText(current));
    return insertMemory(groupId, createKey, sourceKey, data);
  }

  const actions = {
    async groups(_input, actor) {
      return { groups: await auth.userGroups(actor) };
    },

    async bootstrap(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      let botUsername = String(config.botUsername || '').replace(/^@/, '');
      if (!botUsername) {
        try {
          botUsername = (await api.getMe()).username || '';
        } catch {
          botUsername = '';
        }
      }
      return {
        group: { id: group.id, title: group.title },
        actor: me,
        botUsername,
        limits: { ...limits },
      };
    },

    async list(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      const view = input.view || 'active';
      if (!['active', 'pinned', 'trash'].includes(view)) fail('VALIDATION', 'Некорректный вид', { fields: ['view'] });
      const sort = input.sort || 'newest';
      if (!['newest', 'oldest', 'updated'].includes(sort)) fail('VALIDATION', 'Некорректная сортировка', { fields: ['sort'] });
      const type = input.type || undefined;
      if (type && !['text', 'link', 'photo', 'document'].includes(type)) {
        fail('VALIDATION', 'Некорректный тип', { fields: ['type'] });
      }
      if (input.tag !== undefined && typeof input.tag !== 'string') {
        fail('VALIDATION', 'Некорректный тег', { fields: ['tag'] });
      }
      const tag = input.tag ? String(input.tag).normalize('NFKC').toLowerCase().replace(/^#+/, '').trim() : undefined;
      if (tag && tag.length > limits.tag) fail('VALIDATION', 'Некорректный тег', { fields: ['tag'] });
      const size = pageSize(input.pageSize, limits);
      const terms = searchTerms(input.query, limits);
      const cursor = decodeCursor(input.cursor);
      // A query of pure punctuation is a search, not an empty collection view.
      if (terms && terms.length === 0) return { items: [], nextCursor: null };
      const maxId = input.cursor ? undefined : await store.maxId(group.id);
      const rows = await store.list(group.id, {
        view,
        sort,
        type,
        tag,
        terms: terms || [],
        creatorId: input.savedByMe ? me.id : undefined,
        cursor,
        limit: size + 1,
        maxId,
      });
      const page = rows.slice(0, size);
      const items = page.map(row => publicMemory(memoryFromRow(row)));
      const next = rows.length > size ? encodeCursor(items[items.length - 1], sort) : null;
      return { items, nextCursor: next };
    },

    async read(input, actor) {
      const { group } = await authorize(actor, input.group);
      const id = positiveInt(input.id, 'id');
      const row = await store.get(group.id, id);
      if (!row) fail('NOT_FOUND', 'Запись не найдена');
      return publicMemory(memoryFromRow(row));
    },

    async create(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      const rid = requestId(input.requestId);
      // External RPC cannot inject source/attachment/entities — only saveSnapshot may.
      if (input.source != null || input.attachment != null || input.entities != null) {
        fail('VALIDATION', 'Нельзя передать источник или вложение через этот запрос', {
          fields: ['source', 'attachment', 'entities'],
        });
      }
      const fields = content(input, limits);
      return createFromFields(group.id, me, fields, {
        requestId: rid,
        createKey: `rpc:${rid}`,
        sourceKey: null,
      }).then(result => ({ item: result.item, duplicate: result.duplicate }));
    },

    async update(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      const id = positiveInt(input.id, 'id');
      const expected = positiveInt(input.expectedVersion, 'expectedVersion');
      const rid = requestId(input.requestId);
      const item = await casUpdate(group.id, id, expected, (data, current) => {
        if (findApplied(data, rid)) return data;
        if (current.trashed) fail('VALIDATION', 'Сначала восстановите запись из корзины');
        const fields = content(
          {
            title: input.title !== undefined ? input.title : current.title,
            body: input.body !== undefined ? input.body : current.body,
            annotation: input.annotation !== undefined ? input.annotation : current.annotation,
            tags: input.tags !== undefined ? input.tags : current.tags,
            url: input.url !== undefined ? input.url : current.url,
            attachment: current.attachment,
          },
          limits,
          { allowEmptyBody: !!current.attachment },
        );
        if (!fields.body && !current.attachment && !fields.url) {
          fail('VALIDATION', 'Добавьте текст', { fields: ['body'] });
        }
        const at = now();
        const next = {
          ...current,
          title: fields.title,
          body: fields.body,
          annotation: fields.annotation,
          tags: fields.tags,
          url: fields.url,
          type: inferType({ body: fields.body, url: fields.url, attachment: current.attachment }),
          editor: me,
          updatedAt: at,
          version: current.version + 1,
        };
        data.history = [...(data.history || []), historyEntry('update', next, at)];
        data.applied = trimApplied([...(data.applied || []), rid], limits);
        data.current = next;
        data.searchText = buildSearchText(next);
        return data;
      });
      return { item };
    },

    async pin(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      const id = positiveInt(input.id, 'id');
      const expected = positiveInt(input.expectedVersion, 'expectedVersion');
      const rid = requestId(input.requestId);
      if (typeof input.pinned !== 'boolean') fail('VALIDATION', 'Укажите pinned', { fields: ['pinned'] });
      const item = await casUpdate(group.id, id, expected, (data, current) => {
        if (findApplied(data, rid)) return data;
        if (current.trashed) fail('VALIDATION', 'Нельзя закрепить запись из корзины');
        const at = now();
        const next = {
          ...current,
          pinned: input.pinned,
          editor: me,
          updatedAt: at,
          version: current.version + 1,
        };
        data.history = [...(data.history || []), historyEntry(input.pinned ? 'pin' : 'unpin', next, at)];
        data.applied = trimApplied([...(data.applied || []), rid], limits);
        data.current = next;
        data.searchText = buildSearchText(next);
        return data;
      });
      return { item };
    },

    async trash(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      const id = positiveInt(input.id, 'id');
      const expected = positiveInt(input.expectedVersion, 'expectedVersion');
      const rid = requestId(input.requestId);
      const item = await casUpdate(group.id, id, expected, (data, current) => {
        if (findApplied(data, rid)) return data;
        if (current.trashed) return data;
        const at = now();
        const next = {
          ...current,
          trashed: true,
          pinned: false,
          deletedBy: me,
          editor: me,
          updatedAt: at,
          version: current.version + 1,
        };
        data.history = [...(data.history || []), historyEntry('trash', next, at)];
        data.applied = trimApplied([...(data.applied || []), rid], limits);
        data.current = next;
        data.searchText = buildSearchText(next);
        return data;
      });
      return { item };
    },

    async restore(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      const id = positiveInt(input.id, 'id');
      const expected = positiveInt(input.expectedVersion, 'expectedVersion');
      const rid = requestId(input.requestId);
      const item = await casUpdate(group.id, id, expected, (data, current) => {
        if (findApplied(data, rid)) return data;
        if (!current.trashed) return data;
        const at = now();
        const next = {
          ...current,
          trashed: false,
          deletedBy: undefined,
          editor: me,
          updatedAt: at,
          version: current.version + 1,
        };
        delete next.deletedBy;
        data.history = [...(data.history || []), historyEntry('restore', next, at)];
        data.applied = trimApplied([...(data.applied || []), rid], limits);
        data.current = next;
        data.searchText = buildSearchText(next);
        return data;
      });
      return { item };
    },

    async history(input, actor) {
      const { group } = await authorize(actor, input.group);
      const id = positiveInt(input.id, 'id');
      const size = pageSize(input.pageSize, limits);
      const row = await store.get(group.id, id);
      if (!row) fail('NOT_FOUND', 'Запись не найдена');
      const all = [...(row.data.history || [])].reverse();
      let start = 0;
      if (input.cursor) {
        const cursorVersion = positiveInt(Number(input.cursor), 'cursor');
        const index = all.findIndex(entry => entry.version === cursorVersion);
        start = index >= 0 ? index + 1 : all.length;
      }
      const slice = all.slice(start, start + size + 1);
      const page = slice.slice(0, size);
      return {
        items: page.map(entry =>
          publicRevision({
            ...entry,
            snapshot: { ...entry.snapshot, id, groupId: group.id, displayId: `M-${id}` },
          }),
        ),
        nextCursor: slice.length > size ? String(page[page.length - 1].version) : null,
      };
    },

    async tags(input, actor) {
      const { group } = await authorize(actor, input.group);
      const tags = await store.tags(group.id);
      const unique = [...new Set(tags)].sort((a, b) => a.localeCompare(b, 'ru'));
      return { tags: unique };
    },

    async export(input, actor) {
      const { group } = await authorize(actor, input.group);
      if (!['json', 'markdown'].includes(input.format)) {
        fail('VALIDATION', 'Укажите format: json или markdown', { fields: ['format'] });
      }
      const size = pageSize(input.pageSize, limits);
      const cursor = decodeCursor(input.cursor);
      const maxId = input.cursor ? undefined : await store.maxId(group.id);
      const rows = await store.list(group.id, {
        view: 'active',
        sort: 'newest',
        terms: [],
        cursor,
        limit: size + 1,
        maxId,
      });
      const page = rows.slice(0, size);
      const items = page.map(row => exportMemory(memoryFromRow(row)));
      const next = rows.length > size ? encodeCursor(items[items.length - 1], 'newest') : null;
      return { items, nextCursor: next, format: input.format };
    },

    async attachment(input, actor) {
      const { actor: me, group } = await authorize(actor, input.group);
      const id = positiveInt(input.id, 'id');
      requestId(input.requestId);
      const row = await store.get(group.id, id);
      if (!row) fail('NOT_FOUND', 'Запись не найдена');
      const memory = memoryFromRow(row);
      const attachment = memory.attachment;
      if (!attachment?.fileId) {
        return { status: 'unavailable' };
      }
      let botUsername = String(config.botUsername || '').replace(/^@/, '');
      if (!botUsername) {
        try {
          botUsername = (await api.getMe()).username || '';
        } catch {
          botUsername = '';
        }
      }
      const startUrl = botUsername ? `https://t.me/${botUsername}?start=file_${group.id}_${id}` : undefined;
      try {
        if (attachment.kind === 'photo') {
          await api.sendPhoto({ chat_id: me.id, photo: attachment.fileId, caption: memory.title });
        } else {
          await api.sendDocument({
            chat_id: me.id,
            document: attachment.fileId,
            caption: memory.title,
          });
        }
        return { status: 'sent' };
      } catch (error) {
        if (isBotApiError(error)) {
          // User has not started the bot — guide them, then retry.
          const description = String(error.description || '').toLowerCase();
          if (
            error.code === 403 ||
            description.includes('chat not found') ||
            description.includes("bot can't initiate") ||
            description.includes('forbidden')
          ) {
            return { status: 'start_required', startUrl };
          }
          // Mark unavailable on permanent file errors without erasing the memory.
          if (description.includes('file') || description.includes('wrong file') || error.code === 400) {
            try {
              await casUpdate(group.id, id, memory.version, (data, current) => {
                if (!current.attachment) return data;
                data.current = {
                  ...current,
                  attachment: { ...current.attachment, available: false },
                  updatedAt: now(),
                  version: current.version + 1,
                  editor: me,
                };
                data.history = [
                  ...(data.history || []),
                  historyEntry('attachment_unavailable', data.current, now()),
                ];
                data.searchText = buildSearchText(data.current);
                return data;
              });
            } catch {
              // Best-effort availability flag.
            }
            return { status: 'unavailable' };
          }
          fail('TEMPORARY', 'Не удалось отправить файл. Попробуйте позже');
        }
        throw error;
      }
    },
  };

  async function execute(action, input, rawActor) {
    const handler = actions[action];
    if (!handler) fail('VALIDATION', 'Неизвестное действие', { fields: ['action'] });
    return handler(input || {}, rawActor);
  }

  async function saveSnapshot(snapshot, rawActor, rid, groupId) {
    const { actor: me, group } = await authorize(rawActor, groupId);
    const request = requestId(rid);
    const fields = content(
      {
        title: snapshot.title,
        body: snapshot.body,
        annotation: snapshot.annotation,
        tags: snapshot.tags,
        url: snapshot.url,
        attachment: snapshot.attachment,
      },
      limits,
    );
    const source = snapshot.source
      ? {
          messageId: snapshot.source.messageId,
          chatId: snapshot.source.chatId,
          date: snapshot.source.date,
          authorName: snapshot.source.authorName,
          ...(snapshot.source.authorId != null ? { authorId: snapshot.source.authorId } : {}),
          ...(snapshot.source.topicId != null ? { topicId: snapshot.source.topicId } : {}),
          ...(snapshot.source.url ? { url: snapshot.source.url } : {}),
        }
      : undefined;
    const sourceKey = sourceKeyOf(source);
    const createKey = sourceKey ? `source:${sourceKey}` : `snap:${request}`;
    const result = await createFromFields(group.id, me, fields, {
      requestId: request,
      createKey,
      sourceKey,
      source,
      attachment: snapshot.attachment,
      entities: snapshot.entities,
    });
    return { item: result.item, duplicate: result.duplicate };
  }

  async function migrateChat(oldId, newId) {
    if (!Number.isSafeInteger(oldId) || !Number.isSafeInteger(newId)) return;
    const group = await store.getGroupByChat(oldId);
    if (group) await store.migrateGroup(group.id, oldId, newId);
  }

  async function botMembership(chat, status) {
    const group = ['administrator', 'creator', 'member'].includes(status)
      ? await auth.registerChat(chat)
      : await store.getGroupByChat(chat?.id);
    if (group) await store.setBotStatus(group.id, group.chatId, status);
  }

  return {
    execute,
    saveSnapshot,
    migrateChat,
    botMembership,
    registerChat: auth.registerChat,
    authorize,
  };
}

export { AppError };
