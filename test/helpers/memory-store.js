/** In-memory stand-in for createStore(db) used by unit tests. */
export function createMemoryStore() {
  const groups = new Map();
  const memories = new Map();
  let nextId = 1;
  const temps = new Map();

  const decode = row => (row ? { ...row, data: structuredClone(row.data) } : null);

  return {
    async ensureGroup(id, chatId, title) {
      const existing = groups.get(id);
      if (existing) {
        existing.chatId = chatId;
        existing.title = title;
        return { ...existing };
      }
      const group = { id, chatId, title, botStatus: 'unknown' };
      groups.set(id, group);
      return { ...group };
    },
    async getGroup(id) {
      const group = groups.get(id);
      return group ? { ...group } : null;
    },
    async migrateGroup(id, oldId, newId) {
      const group = groups.get(id);
      if (group && group.chatId === oldId) group.chatId = newId;
    },
    async setBotStatus(id, chatId, status) {
      const group = groups.get(id);
      if (group && group.chatId === chatId) group.botStatus = status;
    },
    async get(groupId, id) {
      const row = memories.get(`${groupId}:${id}`);
      return decode(row);
    },
    async findCreate(groupId, createKey, sourceKey) {
      for (const row of memories.values()) {
        if (row.groupId !== groupId) continue;
        if (row.createKey === createKey || (sourceKey && row.sourceKey === sourceKey)) return decode(row);
      }
      return null;
    },
    async insert(groupId, createKey, sourceKey, data) {
      // Mirrors the real store's atomic INSERT guarded by a unique index:
      // the check-and-insert runs without yielding.
      for (const row of memories.values()) {
        if (row.groupId !== groupId) continue;
        if (row.createKey === createKey || (sourceKey && row.sourceKey === sourceKey)) return null;
      }
      const id = nextId++;
      const row = {
        id,
        groupId,
        group_id: groupId,
        createKey,
        sourceKey,
        data: structuredClone(data),
      };
      memories.set(`${groupId}:${id}`, row);
      return decode(row);
    },
    async cas(groupId, id, version, data) {
      const row = memories.get(`${groupId}:${id}`);
      if (!row || row.data.current.version !== version) return null;
      row.data = structuredClone(data);
      return decode(row);
    },
    async list(groupId, filters) {
      let rows = [...memories.values()].filter(row => row.groupId === groupId);
      rows = rows.filter(row => !!row.data.current.trashed === (filters.view === 'trash'));
      if (filters.view === 'pinned') rows = rows.filter(row => row.data.current.pinned);
      if (filters.creatorId) rows = rows.filter(row => row.data.current.creator.id === filters.creatorId);
      if (filters.type) rows = rows.filter(row => row.data.current.type === filters.type);
      if (filters.tag) {
        const needle = JSON.stringify(filters.tag);
        rows = rows.filter(row => JSON.stringify(row.data.current.tags).includes(needle.slice(1, -1) === filters.tag ? `"${filters.tag}"` : needle));
      }
      for (const term of filters.terms || []) {
        rows = rows.filter(row => row.data.searchText.includes(term));
      }
      if (filters.maxId) rows = rows.filter(row => row.id <= filters.maxId);
      const column = filters.sort === 'updated' ? 'updatedAt' : 'createdAt';
      const direction = filters.sort === 'oldest' ? 1 : -1;
      rows.sort((a, b) => {
        const av = a.data.current[column];
        const bv = b.data.current[column];
        if (av !== bv) return av < bv ? -direction : direction;
        return a.id < b.id ? -direction : direction;
      });
      if (filters.cursor) {
        rows = rows.filter(row => {
          const time = row.data.current[column];
          if (direction < 0) return time < filters.cursor.time || (time === filters.cursor.time && row.id < filters.cursor.id);
          return time > filters.cursor.time || (time === filters.cursor.time && row.id > filters.cursor.id);
        });
      }
      return rows.slice(0, filters.limit).map(decode);
    },
    async maxId(groupId) {
      let max = 0;
      for (const row of memories.values()) if (row.groupId === groupId) max = Math.max(max, row.id);
      return max;
    },
    async tags(groupId) {
      return [...memories.values()]
        .filter(row => row.groupId === groupId && !row.data.current.trashed)
        .flatMap(row => row.data.current.tags);
    },
    async putTemp(groupId, key, value, expiresAt) {
      temps.set(`${groupId}:${key}`, { value: structuredClone(value), expiresAt });
    },
    async getTemp(groupId, key, now = Date.now()) {
      const row = temps.get(`${groupId}:${key}`);
      if (!row || row.expiresAt <= now) return null;
      return structuredClone(row.value);
    },
    async deleteTemp(groupId, key) {
      temps.delete(`${groupId}:${key}`);
    },
  };
}
