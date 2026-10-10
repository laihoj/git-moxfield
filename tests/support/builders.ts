/**
 * Test builders for canonical snapshots.
 *
 * `buildSnapshot` produces a canonical snapshot (sorted cards, merged duplicates,
 * empty zones omitted) by passing the spec through `canonicalizeSnapshot`. Tests of
 * the canonicalizer itself assert on explicit literals instead of using this builder.
 *
 * Card specs:
 *   'Island'                       → 1 Island, default printing
 *   '3 Island'                     → 3 Island
 *   { name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703' }] }
 */
import { canonicalizeSnapshot } from '@/core/canonical';
import { cardKey, normalizeCardName } from '@/core/card-key';
import type {
  CanonicalCard,
  CanonicalPrinting,
  CanonicalSnapshot,
  CardIdentityIds,
  DeckInfo,
  ZoneMap,
} from '@/core/model';
import { SNAPSHOT_SCHEMA_VERSION } from '@/core/model';
import type { ZoneId } from '@/core/zones';

export interface PrintingSpec {
  set?: string;
  collectorNumber?: string;
  finish?: string;
  lang?: string;
  quantity?: number;
  flags?: string[];
  ids?: CanonicalPrinting['ids'];
}

export type CardSpec =
  | string
  | {
      name: string;
      quantity?: number;
      printings?: PrintingSpec[];
      ids?: CardIdentityIds;
      /** When true, the card gets no printings at all. */
      noPrintings?: boolean;
    };

export interface SnapshotSpec {
  deck?: Partial<DeckInfo>;
  zones?: Partial<Record<ZoneId, CardSpec[]>>;
  cardTags?: Record<string, string[]>;
  primer?: string | null;
}

function parseSpec(spec: CardSpec): Exclude<CardSpec, string> {
  if (typeof spec !== 'string') return spec;
  const match = /^(\d+)\s+(.+)$/.exec(spec.trim());
  if (match) {
    const [, quantity = '1', name = ''] = match;
    return { name, quantity: Number(quantity) };
  }
  return { name: spec.trim(), quantity: 1 };
}

function defaultPrinting(name: string, quantity: number): CanonicalPrinting {
  return {
    set: 'tst',
    collectorNumber: String(Math.abs(hashCode(cardKey(name))) % 1000),
    finish: 'nonfoil',
    lang: 'en',
    quantity,
    ids: {},
  };
}

function hashCode(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return h;
}

export function buildCard(spec: CardSpec): CanonicalCard {
  const s = parseSpec(spec);
  const name = normalizeCardName(s.name);
  let printings: CanonicalPrinting[];
  if (s.noPrintings) {
    printings = [];
  } else if (s.printings && s.printings.length > 0) {
    printings = s.printings.map((p) => {
      const printing: CanonicalPrinting = {
        set: (p.set ?? 'tst').toLowerCase(),
        collectorNumber: p.collectorNumber ?? '1',
        finish: p.finish ?? 'nonfoil',
        lang: p.lang ?? 'en',
        quantity: p.quantity ?? 1,
        ids: p.ids ?? {},
      };
      if (p.flags && p.flags.length > 0) printing.flags = [...new Set(p.flags)].sort();
      return printing;
    });
  } else {
    printings = [defaultPrinting(name, s.quantity ?? 1)];
  }
  const quantity = s.quantity ?? (printings.length > 0 ? printings.reduce((n, p) => n + p.quantity, 0) : 1);
  return { key: cardKey(name), name, quantity, printings, ids: s.ids ?? {} };
}

/** Builds a snapshot from a spec and runs it through the production canonicalizer. */
export function buildSnapshot(spec: SnapshotSpec = {}): CanonicalSnapshot {
  const zones: ZoneMap = {};
  for (const [zone, cards] of Object.entries(spec.zones ?? {}) as [ZoneId, CardSpec[]][]) {
    zones[zone] = cards.map(buildCard);
  }
  return canonicalizeSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    deck: {
      name: spec.deck?.name ?? 'Test Deck',
      format: spec.deck?.format ?? 'commander',
      description: spec.deck?.description ?? '',
      tags: spec.deck?.tags ?? [],
    },
    zones,
    cardTags: spec.cardTags ?? {},
    primer: spec.primer === undefined ? '' : spec.primer,
  });
}

/** A small Tymna/Kraum style deck used across tests. */
export function baseDeckSpec(): SnapshotSpec {
  return {
    deck: { name: 'Blue Farm', format: 'commander', tags: ['cEDH'] },
    zones: {
      commanders: ['Tymna the Weaver', "Kraum, Ludevic's Opus"],
      mainboard: [
        'Dress Down',
        'Underworld Breach',
        "Thassa's Oracle",
        'Demonic Tutor',
        'Rhystic Study',
        '3 Island',
        'Sol Ring',
      ],
      considering: ['Mnemonic Betrayal', 'Peer into the Abyss'],
      sideboard: ['Orcish Bowmasters'],
    },
    primer: "# Blue Farm\n\nWin with Thassa's Oracle.\n",
  };
}
