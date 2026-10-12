'use client';

import clsx from 'clsx';
import { FileJson, Upload, X } from 'lucide-react';
import { useId, useRef, useState, type DragEvent } from 'react';

import { isRecord } from '@/core/guards';
import { isEncodedCapturePayload } from '@/integrations/moxfield/capture-codec-protocol';
import { classifyCaptureJson, MAX_CAPTURE_BYTES } from '@/integrations/moxfield/capture-protocol';
import { buttonClasses } from '@/components/ui/button';
import { ErrorText, fieldControlProps, fieldDescriptionIds } from '@/components/ui/field';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { formatBytes } from '@/lib/format';

import { inflateCapturePayload, type InflateFailure } from './capture-payload';

/** What a pasted text looks like, detected client-side for immediate feedback. */
export type PastedKind = 'envelope' | 'wrapper' | 'deck' | 'primer' | 'unknown' | 'invalid';

export interface PastedContent {
  /**
   * The pasted JSON text. Compressed text (the bookmarklet's clipboard fallback) is
   * inflated first; it stays compressed only in a browser that cannot inflate it.
   */
  text: string;
  /** UTF-8 size of {@link text}. */
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

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A deck given as an object, or as the JSON text of one (the paste form's `{ deck, primer }`). */
function deckObject(deck: unknown): Record<string, unknown> | undefined {
  let value = deck;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

/** Parses pasted text just enough to tell a deck, a primer and a capture apart (as the server does, see `classifyCaptureJson`). */
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
  if (!isRecord(parsed)) return { ...base, kind: 'unknown' };
  const named = (deck: Record<string, unknown> | undefined) => ({
    name: text(deck?.name),
    internalId: text(deck?.id),
    publicId: text(deck?.publicId),
  });
  switch (classifyCaptureJson(parsed)) {
    case 'envelope':
      return { ...base, kind: 'envelope', ...named(deckObject(parsed.deck)) };
    case 'wrapper':
      return { ...base, kind: 'wrapper', ...named(deckObject(parsed.deck)) };
    case 'primer':
      return { ...base, kind: 'primer' };
    case 'other':
      // Anything else is taken to be a deck by the server; the preview wants a sign of one.
      return 'boards' in parsed || 'publicId' in parsed || 'mainboard' in parsed
        ? { ...base, kind: 'deck', ...named(parsed) }
        : { ...base, kind: 'unknown' };
  }
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

const SIZE_LIMIT = `limit ${formatBytes(MAX_CAPTURE_BYTES)}`;

const PASTE_TOO_LARGE = `The pasted data is too large to import (${SIZE_LIMIT}).`;

/** Why pasted compressed text could not be read. */
const INFLATE_PROBLEMS: Record<Exclude<InflateFailure, 'unavailable'>, string> = {
  'too-large': PASTE_TOO_LARGE,
  malformed:
    'The pasted deck data is damaged or incomplete. Run the bookmarklet on the Moxfield deck page again, then paste again.',
  'unsupported-encoding':
    'The pasted deck data is compressed in a format this version of git-moxfield cannot read.',
};

/**
 * Receives large JSON by paste, drop or file picker without ever rendering it: the
 * textarea stays empty (a 1 MB value would freeze mobile browsers) and a summary with
 * the size and the detected deck name is shown instead. Compressed capture payloads (what
 * the bookmarklet copies when its popup is blocked) are inflated and summarized the same
 * way.
 */
export function PasteZone({ label, description, value, onChange, problem }: PasteZoneProps) {
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  /** Incremented by every input and clear, so that a slow inflate cannot override a newer one. */
  const latest = useRef(0);

  function accept(raw: string, source: PastedContent['source'], fileName?: string): void {
    if (raw.trim() === '') return;
    const attempt = ++latest.current;
    if (!isEncodedCapturePayload(raw)) {
      if (raw.length > MAX_CAPTURE_BYTES) {
        setReadError(PASTE_TOO_LARGE);
        return;
      }
      setReadError(null);
      onChange(inspectPasted(raw, source, fileName));
      return;
    }
    void inflateCapturePayload(raw).then((result) => {
      if (attempt !== latest.current) return;
      if (result.ok) {
        setReadError(null);
        onChange(inspectPasted(result.text, source, fileName));
      } else if (result.reason === 'unavailable') {
        // Sent as it is; the server reads it. Only bookmarklets compress, so it is a capture.
        const text = raw.trim();
        setReadError(null);
        onChange({ text, bytes: text.length, kind: 'envelope', source, fileName });
      } else {
        setReadError(INFLATE_PROBLEMS[result.reason]);
      }
    });
  }

  function readFile(file: File): void {
    if (file.size > MAX_CAPTURE_BYTES) {
      setReadError(`${file.name} is too large to import (${SIZE_LIMIT}).`);
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
            value=""
            rows={3}
            placeholder={description}
            {...fieldControlProps(id, { invalid: message !== null, hint: false })}
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
            <label
              className={clsx(
                buttonClasses({ variant: 'secondary', size: 'sm' }),
                'cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent',
              )}
            >
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
            latest.current += 1;
            onChange(null);
          }}
        />
      )}
      {message !== null && <ErrorText id={fieldDescriptionIds(id).error}>{message}</ErrorText>}
    </div>
  );
}

const KIND_LABELS: Record<PastedKind, string> = {
  envelope: 'Bookmarklet capture',
  wrapper: 'Deck and primer',
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
