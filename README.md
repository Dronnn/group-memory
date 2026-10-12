# Group Memory · Память чата

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.frontend.json)
[![Tests](https://img.shields.io/badge/tests-69%20passing-brightgreen)](test)

**A shared memory for a Telegram group.** The good stuff in a busy chat — explanations, code
snippets, links, decisions, screenshots — usually drowns in the scrollback. Group Memory gives the
group one deliberately-curated, searchable collection: save a message with a reply, browse and edit
it together in a polished Mini App, and never lose an answer worth keeping.

Built end-to-end on Telegram's serverless platform: bot handlers and a database in `tgcloud/`, a
React + TypeScript Mini App in `src/`, no servers to run and no npm packages in the runtime.

## Features

**Saving is explicit and instant**
- Reply `/remember` in the chat to snapshot exactly that message — text, formatting, code blocks,
  links, one photo or one document, with the original author attached as attribution.
- `/remember <текст>` for a standalone note, or the addressed shortcut `@yourbot запомни <текст>`.
- A full editor in the Mini App: title, multiline body, annotation, tags, URL — with a
  deterministic auto-title you can edit.
- Nothing else is ever archived. Ordinary conversation is not read, indexed or sent anywhere, and
  there is no LLM dependency — saving, titles, tags and search are deterministic.

**The collection belongs to the group**
- Every current member has the same rights: create, read, search, edit anyone's item, tag, pin,
  trash, restore, read history, export. Authorship is attribution, never ownership.
- Optimistic concurrency: if someone edited first, you get a conflict, see the latest version, and
  keep your draft — nothing is overwritten silently.
- Trash is reversible, with full history. There is no permanent delete and no auto-purge.
- Pinning is application-only; it never touches the Telegram chat.

**Search that works for Russian and English**
- Case-insensitive matching through explicit NFKC normalization, so «ДЕПЛОЙ» finds «деплой».
- Multiple terms narrow results, tag and type filters combine with the query, and query punctuation
  is never interpreted as SQL or wildcards.
- Filters for pinned, «saved by me», and Trash; newest / oldest / recently-updated sorting with
  stable, cursor-based pagination.

**Safe by construction**
- Every protected operation — including history, export and file delivery — re-resolves the actor,
  the group, and live membership through the Bot API. No positive cache that could outlive a
  membership change; verification failures fail closed.
- Identity comes only from platform-validated Mini App init data and trusted bot updates. Client
  IDs and `startapp` locators are navigation hints, never credentials.
- Telegram file references never reach the frontend; attachments are delivered privately by the bot
  on request, and an unavailable file never erases the memory.
- Parameterized SQL everywhere, `http(s)`-only links without embedded credentials, and rendered
  content that cannot execute saved code.

**A Mini App that feels native**
- Mobile-first layout on Telegram theme variables (light and dark), safe areas, back navigation,
  comfortable touch targets, skeleton/loading/empty/offline/access-denied states.
- Readable code blocks with a copy button, item history, one-tap export to JSON or Markdown, and a
  refresh-on-return model instead of constant polling.

## How it works

```
Telegram group ──updates──▶ tgcloud/handlers/*  ┐
                                                ├─▶ lib/service.js ──▶ lib/store.js ──▶ SQLite
Mini App ──POST /api/memory (initData)──▶ endpoints/memory.js ┘        (platform database)
```

- **One authorization layer** (`lib/auth.js`) is used by handlers and endpoints alike: actor from
  trusted context, configured group, live membership via `getChatMember`, and bot-admin status.
  Everything else — validation, search normalization, mutations, revisions, idempotency,
  formatting — lives in `lib/service.js`, so handlers and endpoints stay thin.
- **One aggregate row per memory.** Current content, immutable history and applied request-ID
  receipts commit together; creates race safely through unique `create_key`/`source_key` indexes,
  and mutations use a version-checked `UPDATE … RETURNING` (CAS). No transactions required, no
  silent overwrites, and retries never duplicate.
- **Idempotency end to end.** Telegram update IDs, per-action request IDs, and the saved source
  message all converge on a single memory.
- **Verified platform primitives only.** The implementation was written against the documented
  Telegram Serverless SDK (`docs/tgcloud-sdk.md`): raw SQL with named parameters, unique indexes,
  no foreign keys, no timers, no filesystem, and a separate explicit schema-migration step.

## Repository layout

| Path | What it is |
|---|---|
| `tgcloud/schema.js` | Database schema: `memories` (aggregate + unique keys), `memory_groups`, `memory_temporary` |
| `tgcloud/lib/` | `auth`, `service`, `store`, `search`, `validation`, `public`, `errors`, `commands`, `snapshot`, `bot`, runtimes |
| `tgcloud/handlers/` | `message`, `callback_query`, `my_chat_member` update handlers |
| `tgcloud/endpoints/memory.js` | Mini App RPC facade (`POST /api/memory`); identity only from `ctx.initData` |
| `src/` | Mini App: `App.tsx`, transport (`api.ts`), components, styles, dev-only fixture transport |
| `test/` | Node test-runner suites: service, bot flows, units — 69 tests |
| `docs/contracts.md` | The RPC contract between the Mini App and the backend |
| `docs/tgcloud-sdk.md` | Telegram Serverless SDK reference used by this project |
| `docs/group-guide-ru.md` | A short Russian user guide, ready to post in the group |

## Quick start (local)

```bash
npm install
npm run dev        # Vite dev server with the dev-only fixture transport
npm test           # 69 tests
npm run typecheck  # strict TypeScript over src/
npm run build      # typecheck + production bundle into dist/
```

`npm run dev` serves the UI against an in-memory fixture (`src/dev/fixture.ts`, enabled only in
DEV via `VITE_DEV_FIXTURE=1`). Production builds strip it; there is no auth bypass in the deployed
app.

## Deploying to Telegram

### Prerequisites

1. A bot from [@BotFather](https://t.me/BotFather) with **Serverless enabled** for it
   (BotFather → your bot → *Serverless* → enable).
2. A **CLI Access token** from the same menu (BotFather → bot → *Serverless* → *CLI Access*).
   This is not the bot token; it authorizes `tgcloud login`.
3. The target group's numeric chat id (negative, e.g. `-1001234567890`).
4. The bot added to the group **as an administrator**. The app needs no message-management rights,
   but the Bot API only guarantees `getChatMember` answers about other users for administrators.
5. Group privacy mode: leave the default **enabled** — the bot only needs addressed commands and
   replies, which is exactly how saving works.

### First deployment

```bash
npm install
npx tgcloud login           # paste the CLI Access token (interactive)
# set initialChatId (and optionally botUsername) in tgcloud/lib/config.js
npx tgcloud status          # local vs cloud diff
npm run deploy              # build the Mini App and push modules + static site
npx tgcloud migrate         # apply schema.js to the database (separate, explicit step)
npx tgcloud webhook         # confirm the managed webhook matches handlers/
```

`push` deploys code and the static build exactly as they are on disk — it never builds and never
touches the database. `migrate` is the separate schema step (`--dry-run` previews it). The deploy
prints the Mini App URL (`https://app<app_id>.tgcloud.ai/`); `/api/*` is reserved for endpoints.

### BotFather

1. **Main Mini App**: BotFather → `/mybots` → your bot → *Bot Settings* → *Configure Mini App* →
   enable and set the deployed URL.
2. **Menu button**: *Bot Settings* → *Menu Button* → same URL.
3. **Commands** register themselves from the bot on the first `/start` (private and group scopes).
   To do it manually, BotFather → *Edit Commands*:

   ```
   start - О боте и вход в память
   help - Короткая справка и примеры
   remember - Сохранить текст или выбранное сообщение
   memory - Открыть общую память
   find - Найти по запросу
   recent - Последние записи
   tags - Теги и просмотр
   edit - Изменить запись по ID
   forget - Переместить запись в корзину
   restore - Восстановить запись из корзины
   cancel - Отменить ввод
   ```

In the group the bot posts ordinary URL buttons like `https://t.me/<bot>?startapp=m_<id>` — a
private-chat-only `web_app` button is intentionally not used in groups.

### Configuration

Public deployment settings live in `tgcloud/lib/config.js` — no tokens, ever:

```js
export const config = {
  groupId: 'group_memory',   // stable internal id; keys all stored data
  initialChatId: 0,          // negative chat id of the target group; 0 fails closed
  groupTitle: 'Память чата', // fallback title until the real one is fetched
  botUsername: '',           // without @; empty = resolved via getMe
  limits: {
    title: 120,              // characters
    body: 20000,
    annotation: 20000,
    bodyPlusAnnotation: 20000,
    tags: 10,
    tag: 30,
    pageSize: 25,
    query: 256,
    history: 200,            // revisions per memory before edits are refused
    aggregateBytes: 1_500_000,
    appliedReceipts: 100,
  },
};
```

The CLI keeps its own credentials in the managed `.tgcloud/` state; CI may export `TGCLOUD_TOKEN`
(see `.env.example`). Neither the bot token nor the CLI token is ever stored in this repository,
in the Mini App bundle, or in logs.

### Schema changes (safe procedure)

1. Edit `tgcloud/schema.js`; **adding** tables/columns/indexes is applied by `npx tgcloud migrate`.
2. **Dropping** happens only through `.deprecated('reason')` on the declaration — deleting a
   declaration does not drop data.
3. **Type changes** are manual (`db.run(...)`), per the platform docs.
4. There are no foreign keys (unsupported); integrity is enforced in application code.
5. Current content and history share one aggregate row with a version CAS — keep both consistent
   when changing the memory shape.

## Testing

`npm test` runs 69 tests on the Node test runner with an in-memory store and a fake Bot API:

- authorization matrix (creator/administrator/member, restricted + `is_member`, left/kicked),
  membership re-checks without caching, fail-closed behavior, bot-removal suspension;
- idempotent creates, concurrent same-source saves converging on one memory, duplicate handling;
- CAS edit conflicts returning the latest state, no-op retries, trash/restore history, pinning;
- search: NFKC + Cyrillic/Latin case folding, multi-term narrowing, tag/type filters, punctuation
  safety, stable cursor pagination with new items arriving;
- validation limits and field-level errors, export pagination without file references;
- attachment delivery states (sent / start required / unavailable) and the protected projections;
- group scoping, chat migration, command parsing, pending input scoped per member and topic,
  confirmation callbacks scoped to actor/item/topic with expiry, snapshot extraction for text,
  photo, document, unsupported media and anonymous senders.

**Manual acceptance run** (two ordinary members + one outsider, on the real platform): both save
items and see the same collection; edit each other's; trash and restore; confirm ordinary chatter
creates nothing; search Cyrillic and Latin text; confirm the outsider is denied; confirm a removed
member is denied on the next request; request an attachment into a private chat; export JSON and
Markdown.

**Status:** everything above is automated except the live-platform pass, which requires the
operator's bot credentials — the checklist is the first thing to run after deployment.

## Export

Every member can export active memories as structured JSON or readable Markdown from the Mini App.
Exports are paginated with bounded requests, and membership is re-checked on every page. Included:
ids, titles, bodies, annotations, tags, URL, type, pin state, creator, last editor, timestamps,
version, trash state, source attribution and message link, attachment metadata (marked as a
Telegram reference, not a file backup). Excluded: Telegram file ids, internal keys, authorization
state, and every other group's data. Import is out of scope.

## Limitations (by design)

- One configured group; this is not a multi-group SaaS.
- One selected message per save — no album or thread capture, no history import.
- Text/caption, one photo, one document; other media types are explained, not archived.
- Attachment availability depends on Telegram `file_id`s; a missing file never erases the memory.
- Trash is terminal — no permanent delete or automatic purge in this version.
- Membership checks need the Bot API: while the bot cannot verify (removed, demoted, API outage),
  access fails closed with a retry message and data is preserved.
- Search covers title, body, annotation, tags, URL and document filenames — not document contents,
  and it is not semantic.

## License

[MIT](LICENSE)
