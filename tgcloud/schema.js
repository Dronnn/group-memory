import { table, integer, text, index, uniqueIndex } from 'sdk/db';
// Each entry, immutable revision log, and mutation receipts commit in one row.
export const memories = table('memories', {
  id: integer('id').primaryKey({ autoIncrement: true }), groupId: text('group_id').notNull(),
  createKey: text('create_key').notNull(), sourceKey: text('source_key'), version: integer('version').notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  trashed: integer('trashed').notNull(), pinned: integer('pinned').notNull(), creatorId: integer('creator_id').notNull(),
  type: text('type').notNull(), searchText: text('search_text').notNull(), tagsText: text('tags_text').notNull(), aggregate: text('aggregate').notNull(),
}, t => ({ createUnique: uniqueIndex('memory_create_unique').on(t.groupId, t.createKey), sourceUnique: uniqueIndex('memory_source_unique').on(t.groupId, t.sourceKey), listing: index('memory_listing').on(t.groupId, t.trashed, t.createdAt, t.id) }));
export const groups = table('memory_groups', {
  id: text('id').primaryKey(), chatId: integer('chat_id').notNull(), title: text('title').notNull(), botStatus: text('bot_status').notNull(),
}, t => ({ byChat: index('memory_groups_chat').on(t.chatId) }));
// Groups where a user has passed a membership check; re-verified live before use.
export const members = table('memory_members', {
  groupId: text('group_id').notNull(), userId: integer('user_id').notNull(), seenAt: integer('seen_at').notNull(),
}, t => ({ memberUnique: uniqueIndex('memory_members_unique').on(t.groupId, t.userId), byUser: index('memory_members_user').on(t.userId, t.seenAt) }));
export const temporary = table('memory_temporary', {
  groupId: text('group_id').notNull(), key: text('key').notNull(), value: text('value').notNull(), expiresAt: integer('expires_at').notNull(),
}, t => ({ keyUnique: uniqueIndex('memory_temp_unique').on(t.groupId, t.key), expiry: index('memory_temp_expiry').on(t.groupId, t.expiresAt) }));
