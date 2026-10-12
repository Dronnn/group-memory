# Implementation contract

All RPC endpoints call the same `service.execute(action,input,actor)` after platform identity resolution. Every action except `groups` takes `group` (`g<digits>`, e.g. `g1001234567890` for chat -1001234567890) and authorizes membership in that group; groups never share data. Endpoint facade: `memory(input,ctx)` where input `{action,...fields}`. Actor only from ctx.initData.user. Service factory `createService({store,api,config,now})` exports execute. SDK wiring in `tgcloud/lib/runtime.js` exports `service`, `store`, `config`, `api`; runtime service.execute ALWAYS rechecks membership and bot admin status. No positive membership cache.

Actions and responses:
- groups {} => {groups:[{id,title}]} — groups where the actor has used the memory, each re-verified live; definite non-members are forgotten.
- bootstrap {group} => {group:{id,title},actor:{id,name},botUsername,limits}
- list {query?,tag?,type?,view?:active|pinned|trash,savedByMe?,sort?:newest|oldest|updated,cursor?,pageSize?} => {items:Memory[],nextCursor:string|null}
- read {id:number} => Memory
- create {requestId:string,title?,body:string,annotation?,tags?:string[],url?,source?,attachment?,entities?} => {item:Memory,duplicate:boolean}. External RPC MUST strip/reject source/attachment/entities; only trusted bot adapter can supply snapshot via service.saveSnapshot(snapshot,actor,requestId,group). Ordinary execute create cannot inject attribution.
- update {id,expectedVersion,requestId,title,body,annotation,tags,url} => {item:Memory}
- pin {id,expectedVersion,requestId,pinned:boolean} => {item:Memory}
- trash / restore {id,expectedVersion,requestId} => {item:Memory}
- history {id,cursor?,pageSize?} => {items:Revision[],nextCursor}
- tags {} => {tags:string[]}
- export {format:json|markdown,cursor?,pageSize?} => {items:ExportMemory[],nextCursor}. Client builds final JSON/Markdown through bounded pages; membership checked every page. No file_id in exports, only attachment metadata/reference classification.
- attachment {id,requestId} => {status:sent|start_required|unavailable,startUrl?:string}. Actual private recipient derived from actor only; no token-bearing URL. Client opens startUrl and retries request after starting.

Memory fields: id:number,displayId:string,groupId:string,title,body,annotation,url,tags:string[],type:text|link|photo|document,pinned:boolean,creator:{id,name},editor:{id,name},createdAt:number(ms),updatedAt:number(ms),version:number,trashed:boolean,deletedBy?:{id,name},source?:{messageId,chatId,date,authorName,authorId?,topicId?,url?},attachment?:{kind:photo|document,fileName?,mimeType?,size?,width?,height?,available?:boolean},entities?:TelegramEntity[]. Protected file_id never returned to frontend. Revision: {version,editor,at,event, snapshot:Memory-like}. Public history omits internal idempotency/file references.

Failures AppError with `.code` and `.message` and optional `.details`; RPC returns EndpointError(message,{code,...details}). CONFLICT includes `latest` public item. ACCESS_DENIED (also unknown group), AUTH_UNAVAILABLE, VALIDATION (fields; missing/malformed `group`), NOT_FOUND, HISTORY_LIMIT, TEMPORARY.

Single-row aggregate memory JSON contains immutable history and applied mutation request IDs alongside latest content; atomic INSERT(unique create key) and version-CAS UPDATE commit everything together. No transaction assumption. Configurable history/aggregate limits refuse edits, never truncate or discard history. Scoped store SQL. Separate bounded temporary states, TTL checked on access; no timer. Groups register themselves (bot added as admin/member, or first command in the chat) with stable id `g<-chatId>`; trusted migration updates the chat_id mapping, the id stays. Mini App start_param: `g<n>`, `g<n>_m_<id>`, `g<n>_e_<id>`, `g<n>_new`; without it the app shows the `groups` picker. Attachment start link: `file_<group>_<id>`.

Bot module owner implements snapshot extraction/commands/pending/confirmation through store temp helpers and service; coordinate exact helper signatures with backend owner. Frontend uses RPC contract above, requestId from browser crypto.randomUUID; no auth bypass in production, development mock isolated by Vite DEV + separate entry.
