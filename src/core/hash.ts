/**
 * Content addressing for snapshots and commits (Git-like, SHA-256).
 *
 * Server-only: uses `node:crypto`. Pure functions otherwise.
 */
import { createHash } from 'node:crypto';

import { stableStringify } from './canonical';
import type { CanonicalSnapshot } from './model';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash of a canonical snapshot. The input must already be canonical. */
export function snapshotHash(snapshot: CanonicalSnapshot): string {
  return sha256Hex(stableStringify(snapshot));
}

export const COMMIT_OBJECT_VERSION = 1 as const;

export interface CommitObject {
  /**
   * `<source>:<externalId>` of the deck **at commit time**, e.g.
   * `moxfield:FixtureDeckId_00000001`. A deck that later follows another source deck
   * ("Change Moxfield deck") keeps the ids of its earlier versions: they hash the
   * reference they were committed under.
   */
  deck: string;
  snapshotHash: string;
  parentId: string | null;
  /** ISO-8601 UTC timestamp with milliseconds. */
  createdAt: string;
  /** Source revision counter at commit time, when known. */
  sourceVersion: number | null;
  message: string;
}

/**
 * Serializes a commit object, modelled on Git's commit object format. Headers are
 * single-line; the message follows after a blank line with line endings normalized.
 */
export function serializeCommitObject(commit: CommitObject): string {
  const singleLine = (label: string, value: string): string => {
    if (/[\r\n]/.test(value)) throw new TypeError(`Commit header ${label} must be single-line`);
    return `${label} ${value}`;
  };
  const lines = [
    `git-moxfield-commit ${COMMIT_OBJECT_VERSION}`,
    singleLine('deck', commit.deck),
    singleLine('snapshot', commit.snapshotHash),
  ];
  if (commit.parentId !== null) lines.push(singleLine('parent', commit.parentId));
  lines.push(singleLine('created-at', commit.createdAt));
  if (commit.sourceVersion !== null) {
    if (!Number.isSafeInteger(commit.sourceVersion)) {
      throw new TypeError(`Commit source-version must be an integer, got ${String(commit.sourceVersion)}`);
    }
    lines.push(singleLine('source-version', String(commit.sourceVersion)));
  }
  const message = commit.message.normalize('NFC').replace(/\r\n?/g, '\n');
  return `${lines.join('\n')}\n\n${message}`;
}

/** Content-addressed commit id: sha256 of the serialized commit object. */
export function commitId(commit: CommitObject): string {
  return sha256Hex(serializeCommitObject(commit));
}

/** Abbreviated id for display, like `git log --oneline`. */
export function shortId(id: string, length = 7): string {
  return id.slice(0, length);
}
