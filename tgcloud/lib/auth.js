import { fail } from './errors.js';
import { actorIdentity, groupIdOf, groupRef } from './validation.js';

function isBotApiError(error) {
  return Boolean(error && (error.name === 'BotApiError' || error.method || error.description));
}

const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);
const GROUP_CHATS = new Set(['group', 'supergroup']);
const PICKER_LIMIT = 10;

/**
 * Membership and bot-admin checks for every protected operation.
 * No positive membership cache — callers must invoke this on each request.
 */
export function createAuth({ store, api, now = () => Date.now() }) {
  async function resolveGroup(groupId) {
    const group = await store.getGroup(groupRef(groupId));
    if (!group?.chatId) fail('ACCESS_DENIED', 'Доступ только для участников группы');
    return group;
  }

  /** Any group or supergroup registers itself on first contact; one collection per chat. */
  async function registerChat(chat) {
    if (!chat || !GROUP_CHATS.has(chat.type) || !Number.isSafeInteger(chat.id) || chat.id >= 0) return null;
    return (await store.getGroupByChat(chat.id)) || store.ensureGroup(groupIdOf(chat.id), chat.id, chat.title || 'Группа');
  }

  function acceptMembership(member) {
    if (!member || typeof member.status !== 'string') return false;
    if (MEMBER_STATUSES.has(member.status)) return true;
    if (member.status === 'restricted' && member.is_member === true) return true;
    return false;
  }

  async function requireBotCanAuthorize(group) {
    if (group.botStatus === 'left' || group.botStatus === 'kicked') {
      fail('AUTH_UNAVAILABLE', 'Бот удалён из группы. Доступ временно закрыт');
    }
    try {
      const me = await api.getMe();
      const self = await api.getChatMember({ chat_id: group.chatId, user_id: me.id });
      const status = self?.status;
      if (status !== 'administrator' && status !== 'creator') {
        fail(
          'AUTH_UNAVAILABLE',
          'Бот должен быть администратором группы, чтобы проверять участников',
        );
      }
      if (group.botStatus !== status) await store.setBotStatus(group.id, group.chatId, status);
    } catch (error) {
      if (isBotApiError(error)) {
        fail('AUTH_UNAVAILABLE', 'Не удалось проверить статус бота в группе. Попробуйте позже');
      }
      throw error;
    }
  }

  async function requireMember(rawActor, groupId) {
    const actor = actorIdentity(rawActor);
    const group = await resolveGroup(groupId);
    await requireBotCanAuthorize(group);
    try {
      const member = await api.getChatMember({ chat_id: group.chatId, user_id: actor.id });
      if (!acceptMembership(member)) {
        await store.removeMember(group.id, actor.id);
        fail('ACCESS_DENIED', 'Доступ только для участников группы');
      }
    } catch (error) {
      if (error?.code === 'ACCESS_DENIED' || error?.code === 'AUTH_UNAVAILABLE') {
        throw error;
      }
      if (isBotApiError(error)) {
        const description = String(error.description || '').toLowerCase();
        // Telegram answers 400 "user not found" when the user is unknown to the chat:
        // a definite non-membership, unlike transient failures.
        if (error.code === 400 && (description.includes('user not found') || description.includes('participant'))) {
          await store.removeMember(group.id, actor.id);
          fail('ACCESS_DENIED', 'Доступ только для участников группы');
        }
        fail('AUTH_UNAVAILABLE', 'Не удалось проверить участие в группе. Попробуйте позже');
      }
      throw error;
    }
    await store.touchMember(group.id, actor.id, now());
    let title = group.title;
    try {
      const chat = await api.getChat({ chat_id: group.chatId });
      if (chat?.title && chat.title !== group.title) {
        await store.ensureGroup(group.id, group.chatId, chat.title);
        title = chat.title;
      }
    } catch {
      // Title refresh is best-effort; membership already verified.
    }
    return { actor, group: { id: group.id, chatId: group.chatId, title } };
  }

  /** The user's recently used groups, each re-verified live; failures are left out. */
  async function userGroups(rawActor) {
    const actor = actorIdentity(rawActor);
    const known = await store.groupsOfUser(actor.id, PICKER_LIMIT);
    const checked = await Promise.all(
      known.map(group => requireMember(actor, group.id).then(auth => auth.group, () => null)),
    );
    return checked.filter(Boolean).map(group => ({ id: group.id, title: group.title }));
  }

  return { resolveGroup, registerChat, requireMember, userGroups, acceptMembership };
}
