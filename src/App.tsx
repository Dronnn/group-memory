import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ApiError, errorText, initializeTransport, requestId, rpc, setGroup } from './api';
import { ContentBody } from './components/ContentBody';
import { Icon } from './components/Icon';
import type { Bootstrap, Draft, Filters, GroupRef, Memory, Revision } from './types';
import {
  attachmentMeta,
  draftFrom,
  excerpt,
  formatDate,
  markdownExport,
  parseLocator,
  parseTags,
  safeUrl,
  typeLabel,
  validateDraft,
} from './utils';

type Route =
  | { name: 'list' }
  | { name: 'detail'; id: number }
  | { name: 'edit'; id?: number }
  | { name: 'history'; id: number };

const defaultFilters = (): Filters => ({
  query: '',
  tag: '',
  type: '',
  view: 'active',
  savedByMe: false,
  sort: 'newest',
});

function useTelegramChrome(route: Route, onBack: () => void, dirty: boolean) {
  useEffect(() => {
    const app = window.Telegram?.WebApp;
    app?.ready?.();
    app?.expand?.();
    const back = app?.BackButton;
    const handler = () => onBack();
    if (route.name === 'list') back?.hide?.();
    else {
      back?.show?.();
      back?.onClick?.(handler);
    }
    if (dirty) app?.enableClosingConfirmation?.();
    else app?.disableClosingConfirmation?.();
    return () => back?.offClick?.(handler);
  }, [route, onBack, dirty]);
}

export default function App() {
  const [locator] = useState(() => parseLocator(window.Telegram?.WebApp?.initDataUnsafe?.start_param));
  const groupId = useRef<string | undefined>(locator.group);
  const [choices, setChoices] = useState<GroupRef[]>([]);
  const [picking, setPicking] = useState(false);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [route, setRoute] = useState<Route>(() => {
    if (locator.mode === 'detail' && 'id' in locator) return { name: 'detail', id: locator.id };
    if (locator.mode === 'edit' && 'id' in locator) return { name: 'edit', id: locator.id };
    if (locator.mode === 'new') return { name: 'edit' };
    return { name: 'list' };
  });
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [items, setItems] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [item, setItem] = useState<Memory | null>(null);
  const [history, setHistory] = useState<Revision[]>([]);
  const [draft, setDraft] = useState<Draft>(draftFrom());
  const [baseline, setBaseline] = useState<Draft>(draftFrom());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const bootRef = useRef(boot);
  bootRef.current = boot;

  const goBack = useEffectEvent(() => {
    if (route.name === 'edit' && dirty && !confirm('Отменить несохранённые изменения?')) return;
    if (route.name === 'history' && item) setRoute({ name: 'detail', id: item.id });
    else if (route.name === 'detail' || route.name === 'edit') setRoute({ name: 'list' });
  });

  useTelegramChrome(route, goBack, dirty && route.name === 'edit');

  const showError = useEffectEvent((error: unknown) => {
    const text = errorText(error);
    setBanner(text);
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('error');
    if (error instanceof ApiError && (error.code === 'ACCESS_DENIED' || error.code === 'SESSION_REQUIRED' || error.code === 'NO_GROUPS')) {
      setFatal(text);
    }
  });

  const loadBootstrap = useEffectEvent(async () => {
    setLoading(true);
    setFatal(null);
    try {
      await initializeTransport();
      // Opened without a group link (bot menu, private chat): offer the user's groups.
      if (!groupId.current) {
        const { groups } = await rpc<{ groups: GroupRef[] }>('groups');
        setChoices(groups);
        if (!groups.length) throw new ApiError('NO_GROUPS', '');
        if (groups.length > 1) {
          setPicking(true);
          return;
        }
        groupId.current = groups[0].id;
      }
      setGroup(groupId.current);
      setPicking(false);
      const data = await rpc<Bootstrap>('bootstrap');
      setBoot(data);
      setBanner(null);
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
    }
  });

  const loadList = useEffectEvent(async (reset: boolean) => {
    if (reset) setLoading(true);
    else setLoadingMore(true);
    try {
      const page = await rpc<{ items: Memory[]; nextCursor: string | null }>('list', {
        query: filters.query,
        tag: filters.tag || undefined,
        type: filters.type || undefined,
        view: filters.view,
        savedByMe: filters.savedByMe || undefined,
        sort: filters.sort,
        cursor: reset ? undefined : cursor || undefined,
        pageSize: 20,
      });
      setItems(prev => (reset ? page.items : [...prev, ...page.items]));
      setCursor(page.nextCursor);
      setBanner(null);
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  });

  const loadTags = useEffectEvent(async () => {
    try {
      const result = await rpc<{ tags: string[] }>('tags');
      setTags(result.tags);
    } catch {
      /* non-fatal */
    }
  });

  const loadItem = useEffectEvent(async (id: number) => {
    setLoading(true);
    try {
      const memory = await rpc<Memory>('read', { id });
      setItem(memory);
      setBanner(null);
    } catch (error) {
      showError(error);
      setRoute({ name: 'list' });
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    void loadBootstrap();
  }, []);

  const lastQuery = useRef(filters.query);
  useEffect(() => {
    if (!boot || route.name !== 'list') return;
    const queryChanged = lastQuery.current !== filters.query;
    lastQuery.current = filters.query;
    if (!queryChanged) {
      void loadList(true);
      void loadTags();
      return;
    }
    // Typing in the search field refetches once it pauses.
    const timer = setTimeout(() => {
      void loadList(true);
      void loadTags();
    }, 350);
    return () => clearTimeout(timer);
  }, [boot, route.name, filters]);

  useEffect(() => {
    if (!boot) return;
    if (route.name === 'edit' && !('id' in route && route.id)) {
      const empty = draftFrom();
      setDraft(empty);
      setBaseline(empty);
      setItem(null);
      setErrors({});
      return;
    }
    if ((route.name === 'detail' || route.name === 'edit') && 'id' in route && route.id) {
      void loadItem(route.id);
    }
    if (route.name === 'history' && 'id' in route) {
      void (async () => {
        setLoading(true);
        try {
          const page = await rpc<{ items: Revision[] }>('history', { id: route.id, pageSize: 25 });
          setHistory(page.items);
        } catch (error) {
          showError(error);
        } finally {
          setLoading(false);
        }
      })();
    }
  }, [boot, route]);

  useEffect(() => {
    if (route.name === 'edit' && item && 'id' in route && route.id === item.id) {
      const next = draftFrom(item);
      setDraft(next);
      setBaseline(next);
      setErrors({});
    }
  }, [item, route]);

  useEffect(() => {
    const app = window.Telegram?.WebApp;
    const refresh = () => {
      if (bootRef.current) {
        if (route.name === 'list') void loadList(true);
        if ((route.name === 'detail' || route.name === 'edit') && 'id' in route && route.id) void loadItem(route.id);
      }
    };
    app?.onEvent?.('viewportChanged', refresh);
    app?.onEvent?.('activated', refresh);
    window.addEventListener('online', refresh);
    return () => {
      app?.offEvent?.('viewportChanged', refresh);
      app?.offEvent?.('activated', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [route]);

  async function saveDraft() {
    const nextErrors = validateDraft(draft, !!item?.attachment);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSaving(true);
    try {
      const payload = {
        title: draft.title.trim(),
        body: draft.body,
        annotation: draft.annotation,
        tags: parseTags(draft.tags),
        url: draft.url.trim(),
        requestId: requestId(),
      };
      const result = item
        ? await rpc<{ item: Memory }>('update', { ...payload, id: item.id, expectedVersion: item.version })
        : await rpc<{ item: Memory }>('create', payload);
      setItem(result.item);
      setBaseline(draftFrom(result.item));
      setDraft(draftFrom(result.item));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('success');
      setRoute({ name: 'detail', id: result.item.id });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT' && error.details.latest) {
        setItem(error.details.latest as Memory);
        setBanner(errorText(error));
      } else showError(error);
    } finally {
      setSaving(false);
    }
  }

  async function mutate(action: 'pin' | 'trash' | 'restore', pinned?: boolean) {
    if (!item) return;
    if (action === 'trash' && !confirm(`Переместить ${item.displayId} в корзину?`)) return;
    setSaving(true);
    try {
      const result = await rpc<{ item: Memory }>(action, {
        id: item.id,
        expectedVersion: item.version,
        requestId: requestId(),
        ...(action === 'pin' ? { pinned } : {}),
      });
      setItem(result.item);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('success');
      if (action === 'trash' || action === 'restore') setRoute({ name: 'list' });
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  async function exportCollection(format: 'json' | 'markdown') {
    setSaving(true);
    try {
      const all: Memory[] = [];
      let next: string | null | undefined;
      do {
        const page = await rpc<{ items: Memory[]; nextCursor: string | null }>('export', {
          format,
          cursor: next || undefined,
          pageSize: 25,
        });
        all.push(...page.items);
        next = page.nextCursor;
      } while (next);
      const text = format === 'json' ? JSON.stringify(all, null, 2) : markdownExport(all);
      const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `group-memory.${format === 'json' ? 'json' : 'md'}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  async function requestAttachment() {
    if (!item) return;
    setSaving(true);
    try {
      const result = await rpc<{ status: string; startUrl?: string }>('attachment', {
        id: item.id,
        requestId: requestId(),
      });
      if (result.status === 'sent') setBanner('Файл отправлен в личный чат с ботом.');
      else if (result.status === 'start_required' && result.startUrl) {
        setBanner('Сначала запустите бота в личке, затем повторите запрос.');
        window.Telegram?.WebApp?.openTelegramLink?.(result.startUrl);
      } else setBanner('Файл недоступен. Запись сохранена без копии файла.');
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  function chooseGroup(id?: string) {
    groupId.current = id;
    setBoot(null);
    setItems([]);
    setItem(null);
    setRoute({ name: 'list' });
    void loadBootstrap();
  }

  if (fatal) {
    return (
      <div className="app">
        <div className="banner error">
          <Icon name="book" />
          <strong>Память чата</strong>
          <p>{fatal}</p>
          <button type="button" className="btn primary" onClick={() => void loadBootstrap()}>
            Повторить
          </button>
        </div>
      </div>
    );
  }

  if (picking) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <strong>Выберите группу</strong>
            <span>У каждой группы своя память</span>
          </div>
        </header>
        <div className="list">
          {choices.map(group => (
            <button key={group.id} type="button" className="item" onClick={() => chooseGroup(group.id)}>
              <h2>{group.title}</h2>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>{boot?.group.title || 'Память чата'}</strong>
          <span>{boot ? `Вы: ${boot.actor.name}` : 'Загрузка…'}</span>
        </div>
        <div className="row">
          {route.name === 'list' && choices.length > 1 && (
            <button type="button" className="btn" onClick={() => chooseGroup()}>
              Группы
            </button>
          )}
          {route.name !== 'list' && (
            <button type="button" className="icon-btn" aria-label="Назад" onClick={goBack}>
              <Icon name="back" />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Обновить"
            onClick={() => {
              if (route.name === 'list') void loadList(true);
              else if (item) void loadItem(item.id);
              else void loadBootstrap();
            }}
          >
            <Icon name="refresh" />
          </button>
          {route.name === 'list' && (
            <button type="button" className="btn primary" onClick={() => setRoute({ name: 'edit' })}>
              <Icon name="plus" size={18} />
              Добавить
            </button>
          )}
        </div>
      </header>

      {banner && (
        <div className="banner">
          <p>{banner}</p>
          <button type="button" className="btn" onClick={() => setBanner(null)}>
            Закрыть
          </button>
        </div>
      )}

      {route.name === 'list' && (
        <>
          <div className="toolbar">
            <label className="search">
              <Icon name="search" size={18} />
              <input
                value={filters.query}
                placeholder="Поиск по тексту и тегам"
                maxLength={256}
                onChange={event => setFilters(f => ({ ...f, query: event.target.value }))}
                onKeyDown={event => {
                  if (event.key === 'Enter') void loadList(true);
                }}
              />
            </label>
            <button type="button" className="btn" onClick={() => void loadList(true)}>
              Найти
            </button>
          </div>
          <div className="filters">
            {(
              [
                ['active', 'Активные'],
                ['pinned', 'Закреплённые'],
                ['trash', 'Корзина'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`chip ${filters.view === value ? 'active' : ''}`}
                onClick={() => setFilters(f => ({ ...f, view: value }))}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={`chip ${filters.savedByMe ? 'active' : ''}`}
              onClick={() => setFilters(f => ({ ...f, savedByMe: !f.savedByMe }))}
            >
              Мои
            </button>
            <select
              className="chip"
              value={filters.sort}
              onChange={event => setFilters(f => ({ ...f, sort: event.target.value as Filters['sort'] }))}
              aria-label="Сортировка"
            >
              <option value="newest">Сначала новые</option>
              <option value="oldest">Сначала старые</option>
              <option value="updated">По обновлению</option>
            </select>
            <select
              className="chip"
              value={filters.type}
              onChange={event => setFilters(f => ({ ...f, type: event.target.value }))}
              aria-label="Тип"
            >
              <option value="">Все типы</option>
              <option value="text">Текст</option>
              <option value="link">Ссылка</option>
              <option value="photo">Фото</option>
              <option value="document">Документ</option>
            </select>
            <select
              className="chip"
              value={filters.tag}
              onChange={event => setFilters(f => ({ ...f, tag: event.target.value }))}
              aria-label="Тег"
            >
              <option value="">Все теги</option>
              {tags.map(tag => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => void exportCollection('markdown')}>
              <Icon name="download" size={16} />
              Markdown
            </button>
            <button type="button" className="btn" onClick={() => void exportCollection('json')}>
              JSON
            </button>
          </div>
          <div className="list">
            {loading && !items.length && (
              <>
                <div className="skeleton" />
                <div className="skeleton" />
              </>
            )}
            {!loading && !items.length && (
              <div className="empty">
                <Icon name="book" />
                <strong>{filters.query ? 'Ничего не найдено' : 'Пока пусто'}</strong>
                <p className="muted">Сохраните первую запись кнопкой «Добавить» или командой /remember в группе.</p>
              </div>
            )}
            {items.map(memory => (
              <button
                key={memory.id}
                type="button"
                className="item"
                onClick={() => setRoute({ name: 'detail', id: memory.id })}
              >
                <div className="item-top">
                  <span className="type-pill">
                    <Icon name={memory.type} size={16} />
                    {typeLabel[memory.type]}
                  </span>
                  {memory.pinned && (
                    <span className="type-pill">
                      <Icon name="pin" size={14} />
                    </span>
                  )}
                  {memory.attachment && (
                    <span className="type-pill">
                      <Icon name={memory.attachment.kind} size={14} />
                    </span>
                  )}
                  <span className="spacer" />
                  <span className="meta">{memory.displayId}</span>
                </div>
                <h2>{memory.title}</h2>
                <p className="excerpt">{excerpt(memory.body || memory.annotation || memory.url)}</p>
                <div className="row">
                  {memory.tags.map(tag => (
                    <span className="tag" key={tag}>
                      #{tag}
                    </span>
                  ))}
                </div>
                <div className="meta">
                  {memory.creator.name} · {formatDate(memory.createdAt)}
                </div>
              </button>
            ))}
            {cursor && (
              <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadList(false)}>
                {loadingMore ? 'Загрузка…' : 'Ещё'}
              </button>
            )}
          </div>
        </>
      )}

      {route.name === 'detail' && item && (
        <section className="panel">
          <div className="item-top">
            <span className="type-pill">
              <Icon name={item.type} size={16} />
              {typeLabel[item.type]} · {item.displayId}
            </span>
            {item.pinned && <Icon name="pin" size={16} />}
            {item.trashed && <span className="tag">В корзине</span>}
          </div>
          <h1>{item.title}</h1>
          <ContentBody body={item.body} entities={item.entities} />
          {item.annotation && (
            <div className="field-box">
              <div className="muted">Примечание</div>
              <div className="body">{item.annotation}</div>
            </div>
          )}
          {safeUrl(item.url) && (
            <a href={safeUrl(item.url)} target="_blank" rel="noreferrer">
              {item.url}
            </a>
          )}
          <div className="row">
            {item.tags.map(tag => (
              <span className="tag" key={tag}>
                #{tag}
              </span>
            ))}
          </div>
          {item.attachment && (
            <div className="field-box">
              <div className="row">
                <Icon name={item.attachment.kind} />
                <div>
                  <strong>
                    {item.attachment.kind === 'photo' ? 'Фото' : item.attachment.fileName || 'Документ'}
                  </strong>
                  {attachmentMeta(item.attachment) && <div className="muted">{attachmentMeta(item.attachment)}</div>}
                  <div className="muted">
                    {item.attachment.available === false
                      ? 'Файл больше недоступен в Telegram'
                      : 'Ссылка на файл в Telegram, не резервная копия'}
                  </div>
                </div>
              </div>
              {item.attachment.available !== false && (
                <button type="button" className="btn" disabled={saving} onClick={() => void requestAttachment()}>
                  Получить файл в личку
                </button>
              )}
            </div>
          )}
          {item.source && (
            <div className="field-box">
              <div className="muted">Источник</div>
              <div>
                {item.source.authorName}
                {item.source.url && (
                  <>
                    {' · '}
                    <a href={item.source.url} target="_blank" rel="noreferrer">
                      сообщение
                    </a>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="meta">
            Сохранил(а): {item.creator.name} · {formatDate(item.createdAt)}
            <br />
            Изменил(а): {item.editor.name} · {formatDate(item.updatedAt)} · v{item.version}
          </div>
          <div className="actions">
            {!item.trashed && (
              <>
                <button type="button" className="btn primary" onClick={() => setRoute({ name: 'edit', id: item.id })}>
                  <Icon name="edit" size={16} />
                  Редактировать
                </button>
                <button type="button" className="btn" disabled={saving} onClick={() => void mutate('pin', !item.pinned)}>
                  <Icon name="pin" size={16} />
                  {item.pinned ? 'Открепить' : 'Закрепить'}
                </button>
                <button type="button" className="btn danger" disabled={saving} onClick={() => void mutate('trash')}>
                  <Icon name="trash" size={16} />
                  В корзину
                </button>
              </>
            )}
            {item.trashed && (
              <button type="button" className="btn primary" disabled={saving} onClick={() => void mutate('restore')}>
                Восстановить
              </button>
            )}
            <button type="button" className="btn" onClick={() => setRoute({ name: 'history', id: item.id })}>
              <Icon name="history" size={16} />
              История
            </button>
          </div>
        </section>
      )}

      {route.name === 'edit' && (
        <section className="composer">
          <h1>{item ? `Изменить ${item.displayId}` : 'Новая запись'}</h1>
          <div className="field">
            <label htmlFor="title">Заголовок</label>
            <div className="field-box">
              <input
                id="title"
                value={draft.title}
                maxLength={120}
                onChange={event => setDraft(d => ({ ...d, title: event.target.value }))}
                placeholder="Подставится из текста, если оставить пустым"
              />
            </div>
            {errors.title && <div className="error">{errors.title}</div>}
          </div>
          <div className="field">
            <label htmlFor="body">Текст</label>
            <div className="field-box">
              <textarea
                id="body"
                value={draft.body}
                onChange={event => setDraft(d => ({ ...d, body: event.target.value }))}
                placeholder="Многострочный текст и блоки ```кода```"
              />
            </div>
            {errors.body && <div className="error">{errors.body}</div>}
          </div>
          <div className="field">
            <label htmlFor="annotation">Примечание</label>
            <div className="field-box">
              <textarea
                id="annotation"
                value={draft.annotation}
                onChange={event => setDraft(d => ({ ...d, annotation: event.target.value }))}
                style={{ minHeight: 80 }}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="tags">Теги через запятую</label>
            <div className="field-box">
              <input
                id="tags"
                value={draft.tags}
                onChange={event => setDraft(d => ({ ...d, tags: event.target.value }))}
                placeholder="javascript, правила"
              />
            </div>
            {errors.tags && <div className="error">{errors.tags}</div>}
          </div>
          <div className="field">
            <label htmlFor="url">Ссылка</label>
            <div className="field-box">
              <input
                id="url"
                value={draft.url}
                onChange={event => setDraft(d => ({ ...d, url: event.target.value }))}
                placeholder="https://"
              />
            </div>
            {errors.url && <div className="error">{errors.url}</div>}
          </div>
          <div className="actions">
            <button type="button" className="btn primary" disabled={saving} onClick={() => void saveDraft()}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
            <button type="button" className="btn" onClick={goBack}>
              Отмена
            </button>
          </div>
        </section>
      )}

      {route.name === 'history' && (
        <section className="panel">
          <h1>История</h1>
          {loading && <div className="skeleton" />}
          {!loading && !history.length && <div className="empty">История пока пуста</div>}
          {history.map(entry => (
            <div className="history-item" key={`${entry.version}-${entry.at}`}>
              <div className="item-top">
                <strong>v{entry.version}</strong>
                <span className="tag">{entry.event}</span>
                <span className="spacer" />
                <span className="meta">{formatDate(entry.at)}</span>
              </div>
              <div className="meta">{entry.editor.name}</div>
              <div className="excerpt">{entry.snapshot.title}</div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
