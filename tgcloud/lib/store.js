// SDK raw db.run/all/get use (SQL, named parameters). All calls are awaited.
// There are deliberately no transactions or read-then-write side tables for history.
export function createStore(db) {
  const decode = row => row ? { ...row, data: JSON.parse(row.aggregate) } : null;
  const bind = values => Object.fromEntries(Object.entries(values).map(([k,v]) => [':' + k, v]));
  function columns(groupId, data) {
    const m = data.current;
    return { groupId, version: m.version, createdAt: m.createdAt, updatedAt: m.updatedAt, trashed: +m.trashed, pinned: +m.pinned, creatorId: m.creator.id, type: m.type, searchText: data.searchText, tagsText: JSON.stringify(m.tags), aggregate: JSON.stringify(data) };
  }
  return {
    async ensureGroup(id, chatId, title) {
      await db.run(
        'INSERT INTO memory_groups (id,chat_id,title,bot_status) VALUES (:id,:chatId,:title,\'unknown\') ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, title=excluded.title',
        bind({ id, chatId, title }),
      );
      return this.getGroup(id);
    },
    async getGroup(id) { const row = await db.get('SELECT * FROM memory_groups WHERE id=:id', bind({id})); return row && {id:row.id,chatId:row.chat_id,title:row.title,botStatus:row.bot_status}; },
    async migrateGroup(id, oldId, newId) { return db.run('UPDATE memory_groups SET chat_id=:newId WHERE id=:id AND chat_id=:oldId', bind({id,oldId,newId})); },
    async setBotStatus(id, chatId, status) { return db.run('UPDATE memory_groups SET bot_status=:status WHERE id=:id AND chat_id=:chatId', bind({id,chatId,status})); },
    async get(groupId,id) { return decode(await db.get('SELECT * FROM memories WHERE group_id=:groupId AND id=:id',bind({groupId,id}))); },
    async findCreate(groupId,createKey,sourceKey) { return decode(await db.get('SELECT * FROM memories WHERE group_id=:groupId AND (create_key=:createKey OR (:sourceKey IS NOT NULL AND source_key=:sourceKey)) ORDER BY id LIMIT 1',bind({groupId,createKey,sourceKey}))); },
    async insert(groupId,createKey,sourceKey,data) {
      const result = await db.run('INSERT INTO memories (group_id,create_key,source_key,version,created_at,updated_at,trashed,pinned,creator_id,type,search_text,tags_text,aggregate) VALUES (:groupId,:createKey,:sourceKey,:version,:createdAt,:updatedAt,:trashed,:pinned,:creatorId,:type,:searchText,:tagsText,:aggregate) ON CONFLICT DO NOTHING RETURNING *',bind({...columns(groupId,data),createKey,sourceKey}));
      return decode(result.rows?.[0]);
    },
    async cas(groupId,id,version,data) {
      const result = await db.run('UPDATE memories SET version=:version,updated_at=:updatedAt,trashed=:trashed,pinned=:pinned,type=:type,search_text=:searchText,tags_text=:tagsText,aggregate=:aggregate WHERE group_id=:groupId AND id=:id AND version=:expected RETURNING *',bind({groupId,id,expected:version,version:data.current.version,updatedAt:data.current.updatedAt,trashed:+data.current.trashed,pinned:+data.current.pinned,type:data.current.type,searchText:data.searchText,tagsText:JSON.stringify(data.current.tags),aggregate:JSON.stringify(data)}));
      return decode(result.rows?.[0]);
    },
    async list(groupId, filters) {
      const p = {groupId,trashed: filters.view === 'trash' ? 1 : 0,limit:filters.limit};
      const where = ['group_id=:groupId','trashed=:trashed'];
      if (filters.view === 'pinned') where.push('pinned=1');
      if (filters.creatorId) { where.push('creator_id=:creatorId'); p.creatorId=filters.creatorId; }
      if (filters.type) { where.push('type=:type');p.type=filters.type; }
      if (filters.tag) { where.push('instr(tags_text,:tag)>0');p.tag=JSON.stringify(filters.tag); }
      filters.terms.forEach((term,i) => {where.push(`instr(search_text,:term${i})>0`);p[`term${i}`]=term;});
      const column = filters.sort === 'updated' ? 'updated_at' : 'created_at';
      const direction = filters.sort === 'oldest' ? 'ASC' : 'DESC';
      const comparison = direction === 'ASC' ? '>' : '<';
      if (filters.cursor) { where.push(`(${column}${comparison}:time OR (${column}=:time AND id${comparison}:lastId))`);p.time=filters.cursor.time;p.lastId=filters.cursor.id; }
      if (filters.maxId) {where.push('id<=:maxId');p.maxId=filters.maxId;}
      return (await db.all(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY ${column} ${direction},id ${direction} LIMIT :limit`,bind(p))).map(decode);
    },
    async maxId(groupId) { return (await db.get('SELECT COALESCE(MAX(id),0) AS id FROM memories WHERE group_id=:groupId',bind({groupId}))).id; },
    async tags(groupId) { return (await db.all('SELECT tags_text FROM memories WHERE group_id=:groupId AND trashed=0',bind({groupId}))).flatMap(r => JSON.parse(r.tags_text)); },
    async putTemp(groupId,key,value,expiresAt) {
      if (key.length>240 || JSON.stringify(value).length>100000 || !Number.isSafeInteger(expiresAt)) throw new Error('Invalid temporary state');
      await db.run('DELETE FROM memory_temporary WHERE group_id=:groupId AND expires_at<=:now',bind({groupId,now:Date.now()}));
      await db.run('INSERT INTO memory_temporary (group_id,key,value,expires_at) VALUES (:groupId,:key,:value,:expiresAt) ON CONFLICT(group_id,key) DO UPDATE SET value=:value,expires_at=:expiresAt',bind({groupId,key,value:JSON.stringify(value),expiresAt}));
    },
    async getTemp(groupId,key,now=Date.now()) { const r=await db.get('SELECT value FROM memory_temporary WHERE group_id=:groupId AND key=:key AND expires_at>:now',bind({groupId,key,now}));return r ? JSON.parse(r.value) : null; },
    async deleteTemp(groupId,key) { await db.run('DELETE FROM memory_temporary WHERE group_id=:groupId AND key=:key',bind({groupId,key})); },
  };
}
