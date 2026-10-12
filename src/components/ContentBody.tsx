import { useState } from 'react';
import type { Entity } from '../types';
import { safeUrl } from '../utils';
import { Icon } from './Icon';

function splitCode(body: string) {
  const parts: Array<{ type: 'text' | 'code'; value: string; language?: string }> = [];
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    if (match.index > last) parts.push({ type: 'text', value: body.slice(last, match.index) });
    parts.push({ type: 'code', value: match[2].replace(/\n$/, ''), language: match[1] || undefined });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push({ type: 'text', value: body.slice(last) });
  return parts.length ? parts : [{ type: 'text' as const, value: body }];
}

function linkify(text: string, entities?: Entity[]) {
  const urls = new Map<number, { length: number; href: string }>();
  for (const entity of entities || []) {
    if (entity.type === 'url') {
      const href = safeUrl(text.slice(entity.offset, entity.offset + entity.length));
      if (href) urls.set(entity.offset, { length: entity.length, href });
    }
    if (entity.type === 'text_link') {
      const href = safeUrl(entity.url);
      if (href) urls.set(entity.offset, { length: entity.length, href });
    }
  }
  if (!urls.size) {
    return text.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => {
      const href = safeUrl(part);
      return href ? (
        <a key={index} href={href} target="_blank" rel="noreferrer">
          {part}
        </a>
      ) : (
        <span key={index}>{part}</span>
      );
    });
  }
  const nodes = [];
  let cursor = 0;
  const offsets = [...urls.keys()].sort((a, b) => a - b);
  for (const offset of offsets) {
    if (offset < cursor) continue;
    if (offset > cursor) nodes.push(<span key={`t${cursor}`}>{text.slice(cursor, offset)}</span>);
    const item = urls.get(offset)!;
    const label = text.slice(offset, offset + item.length);
    nodes.push(
      <a key={`a${offset}`} href={item.href} target="_blank" rel="noreferrer">
        {label}
      </a>,
    );
    cursor = offset + item.length;
  }
  if (cursor < text.length) nodes.push(<span key={`t${cursor}`}>{text.slice(cursor)}</span>);
  return nodes;
}

export function ContentBody({ body, entities }: { body: string; entities?: Entity[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="body">
      {splitCode(body).map((part, index) =>
        part.type === 'code' ? (
          <div className="code-block" key={index}>
            <button
              type="button"
              className="icon-btn copy"
              aria-label="Скопировать код"
              onClick={async () => {
                await navigator.clipboard.writeText(part.value);
                setCopied(String(index));
                setTimeout(() => setCopied(null), 1500);
              }}
            >
              <Icon name={copied === String(index) ? 'check' : 'copy'} size={16} />
            </button>
            <pre>{part.value}</pre>
          </div>
        ) : (
          <div key={index}>{linkify(part.value, entities)}</div>
        ),
      )}
    </div>
  );
}
