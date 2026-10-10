'use client';

import clsx from 'clsx';
import { FileJson, Upload, X } from 'lucide-react';
import { useId, useState, type DragEvent } from 'react';

import { MAX_CAPTURE_BYTES } from '@/integrations/moxfield/capture-protocol';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { formatBytes } from '@/lib/format';

/** What a pasted text looks like, detected client-side for immediate feedback. */
export type PastedKind = 'envelope' | 'deck' | 'primer' | 'unknown' | 'invalid';

export interface PastedContent {
  text: string;
  bytes: number;
  kind: PastedKind;
  /** Deck name, when the JSON is a deck or capture envelope. */
  name?: string;
  /** Moxfield's internal deck id (`deck.id`), needed for the primer URL. */
  internalId?: string;
  /** Public deck id, when present. */
  publicId?: string;
  /** Where the content came from, for the summary line. */
  source: 'paste' | 'file';
  fileName?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Parses pasted text just enough to tell a deck, a primer and a capture envelope apart. */
export function inspectPasted(
  raw: string,
  source: PastedContent['source'],
  fileName?: string,
): PastedContent {
  const bytes = new TextEncoder().encode(raw).byteLength;
  const base = { text: raw, bytes, source, fileName };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, kind: 'invalid' };
  }
  const value = record(parsed);
  if (value === null) return { ...base, kind: 'unknown' };
  if (value.kind === 'git-moxfield/capture') {
    const deck = record(value.deck);
    return {
      ...base,
      kind: 'envelope',
      name: text(deck?.name),
      internalId: text(deck?.id),
      publicId: text(deck?.publicId),
    };
  }
  if ('boards' in value || 'publicId' in value || 'mainboard' in value) {
    return {
      ...base,
      kind: 'deck',
      name: text(value.name),
      internalId: text(value.id),
      publicId: text(value.publicId),
    };
  }
  if (typeof value.content === 'string') return { ...base, kind: 'primer' };
  return { ...base, kind: 'unknown' };
}

export interface PasteZoneProps {
  label: string;
  /** Short description of what to paste. */
  description: string;
  value: PastedContent | null;
  onChange: (value: PastedContent | null) => void;
  /** Validation message for the current value, if any. */
  problem?: string | null;
}

/**
 * Receives large JSON by paste, drop or file picker without ever rendering it: the
 * textarea stays empty (a 1 MB value would freeze mobile browsers) and a summary with
 * the size and the detected deck name is shown instead.
 */
export function PasteZone({ label, description, value, onChange, problem }: PasteZoneProps) {
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  function accept(raw: string, source: PastedContent['source'], fileName?: string): void {
    if (raw.trim() === '') return;
    if (raw.length > MAX_CAPTURE_BYTES) {
      setReadError(`That is more than ${formatBytes(MAX_CAPTURE_BYTES)}, too large for a deck.`);
      return;
    }
    setReadError(null);
    onChange(inspectPasted(raw, source, fileName));
  }

  function readFile(file: File): void {
    if (file.size > MAX_CAPTURE_BYTES) {
      setReadError(`${file.name} is larger than ${formatBytes(MAX_CAPTURE_BYTES)}, too large for a deck.`);
      return;
    }
    file.text().then(
      (content) => {
        accept(content, 'file', file.name);
      },
      () => {
        setReadError(`${file.name} could not be read.`);
      },
    );
  }

  function onDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) readFile(file);
    else accept(event.dataTransfer.getData('text/plain'), 'paste');
  }

  const message = problem ?? readError;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      {value === null ? (
        <div
          className={clsx(
            'relative flex flex-col gap-2 rounded-lg border-2 border-dashed p-3 transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface-2/50',
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={onDrop}
        >
          <textarea
            id={id}
            value=""
            rows={3}
            placeholder={description}
            aria-describedby={message !== null ? `${id}-error` : undefined}
            aria-invalid={message !== null || undefined}
            className="block w-full resize-none rounded-md bg-transparent px-1 text-base text-fg placeholder:text-muted focus:outline-none md:text-sm"
            onPaste={(event) => {
              event.preventDefault();
              accept(event.clipboardData.getData('text/plain'), 'paste');
            }}
            onChange={(event) => {
              // Input that bypasses the paste event (e.g. some mobile keyboards).
              accept(event.target.value, 'paste');
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">Paste, drop a .json file, or</span>
            <label className="relative inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg whitespace-nowrap border border-border-strong bg-surface px-3 text-sm font-medium text-fg shadow-card hover:bg-surface-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              <Upload aria-hidden="true" className="size-4" />
              Choose file
              <input
                type="file"
                accept=".json,application/json,text/plain"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) readFile(file);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
        </div>
      ) : (
        <PastedSummary
          value={value}
          invalid={message !== null}
          onClear={() => {
            onChange(null);
          }}
        />
      )}
      {message !== null && (
        <p id={`${id}-error`} role="alert" className="text-sm text-remove">
          {message}
        </p>
      )}
    </div>
  );
}

const KIND_LABELS: Record<PastedKind, string> = {
  envelope: 'Bookmarklet capture',
  deck: 'Deck JSON',
  primer: 'Primer JSON',
  unknown: 'JSON',
  invalid: 'Not valid JSON',
};

function PastedSummary({
  value,
  invalid,
  onClear,
}: {
  value: PastedContent;
  invalid: boolean;
  onClear: () => void;
}) {
  const bad = invalid || value.kind === 'invalid' || value.kind === 'unknown';
  const kind = KIND_LABELS[value.kind];
  const title = value.name ?? value.fileName ?? kind;
  return (
    <div
      className={clsx(
        'flex items-center gap-3 rounded-lg border px-3 py-2.5',
        bad ? 'border-remove/40 bg-remove-bg' : 'border-border bg-surface-2',
      )}
    >
      <FileJson aria-hidden="true" className={clsx('size-5 shrink-0', bad ? 'text-remove' : 'text-accent')} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{title}</p>
        <MetaList className="text-xs text-muted tabular">
          {/* Without a deck or file name the title already says what was pasted. */}
          {title !== kind && <MetaItem>{kind}</MetaItem>}
          <MetaItem>{formatBytes(value.bytes)}</MetaItem>
          {value.source === 'file' && value.fileName !== undefined && value.name !== undefined && (
            <MetaItem>{value.fileName}</MetaItem>
          )}
        </MetaList>
      </div>
      <button
        type="button"
        aria-label="Remove"
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted after:absolute after:-inset-1.5 after:content-[''] hover:bg-surface hover:text-fg md:after:hidden"
        onClick={onClear}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
