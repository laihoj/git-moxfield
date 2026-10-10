/**
 * Encoding and decoding of JSON columns. Internal to `src/server/repositories`.
 *
 * Values are written with `stableStringify` (deterministic, readable in the database)
 * and validated structurally when read back, so a damaged row surfaces as a
 * `corrupt-data` {@link RepositoryError} instead of an `undefined` deep inside the UI.
 */
import { stableStringify } from '@/core/canonical';
import type { IngestWarning, SourceDeckMetadata } from '@/core/model';
import type { IngestMethod } from '@/integrations/deck-source';

import { RepositoryError } from './errors';

/** Serializes a JSON value deterministically. */
export function encodeJson(value: unknown, what: string): string {
  try {
    return stableStringify(value);
  } catch (cause) {
    throw new RepositoryError('invalid-input', `${what} is not JSON-serializable`, { cause });
  }
}

/** Parses a JSON column. */
export function decodeJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RepositoryError('corrupt-data', `${what} is not valid JSON`, { cause });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function corruptData(what: string, problem: string): RepositoryError {
  return new RepositoryError('corrupt-data', `${what}: ${problem}`);
}

const INGEST_METHODS: Record<IngestMethod, true> = {
  server: true,
  'browser-capture': true,
  'manual-paste': true,
};

export function isIngestMethod(value: string): value is IngestMethod {
  return Object.hasOwn(INGEST_METHODS, value);
}

export function decodeIngestMethod(value: string, what: string): IngestMethod {
  if (isIngestMethod(value)) return value;
  throw corruptData(what, `unknown ingest method ${JSON.stringify(value)}`);
}

const REQUIRED_METADATA_STRINGS = ['source', 'externalId', 'url', 'name', 'format'] as const;
const OPTIONAL_METADATA_STRINGS = [
  'internalId',
  'visibility',
  'lastUpdatedAt',
  'createdAt',
  'primerLastUpdatedAt',
] as const;

/** Decodes a `SourceDeckMetadata` JSON column. */
export function decodeSourceMetadata(text: string, what: string): SourceDeckMetadata {
  const value = decodeJson(text, what);
  if (!isRecord(value)) throw corruptData(what, 'expected an object');
  for (const field of REQUIRED_METADATA_STRINGS) {
    if (typeof value[field] !== 'string') throw corruptData(what, `${field} must be a string`);
  }
  for (const field of OPTIONAL_METADATA_STRINGS) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw corruptData(what, `${field} must be a string`);
    }
  }
  if (value.version !== undefined && typeof value.version !== 'number') {
    throw corruptData(what, 'version must be a number');
  }
  if (!isStringArray(value.authors)) throw corruptData(what, 'authors must be a string array');
  if (!isRecord(value.reportedCounts)) throw corruptData(what, 'reportedCounts must be an object');
  return value as unknown as SourceDeckMetadata;
}

/**
 * Decodes an `IngestWarning[]` JSON column. Warning codes are not checked against the
 * current code list, so warnings recorded by older builds stay readable.
 */
export function decodeWarnings(text: string, what: string): IngestWarning[] {
  const value = decodeJson(text, what);
  if (!Array.isArray(value)) throw corruptData(what, 'expected an array');
  for (const warning of value) {
    if (!isRecord(warning) || typeof warning.code !== 'string' || typeof warning.message !== 'string') {
      throw corruptData(what, 'every warning needs a string code and message');
    }
    if (warning.details !== undefined && !isRecord(warning.details)) {
      throw corruptData(what, 'warning details must be an object');
    }
  }
  return value as IngestWarning[];
}

/** Decodes a JSON string-array column (e.g. color identity). */
export function decodeStringArray(text: string, what: string): string[] {
  const value = decodeJson(text, what);
  if (!isStringArray(value)) throw corruptData(what, 'expected a string array');
  return value;
}
