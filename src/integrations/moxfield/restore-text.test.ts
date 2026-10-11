import { describe, expect, it } from 'vitest';

import { buildSnapshot } from '@tests/support/builders';

import { normalizeMoxfieldPayload } from './normalize';
import { moxfieldAsciiName, moxfieldCardLines, moxfieldRestoreExport } from './restore-text';
import { v1Primer, v3Deck } from './test-fixtures';

const BULK_EDIT_STEPS_TAIL = [
  'Click Save once, after all tabs are filled in.',
  'If Moxfield reports "Error on line N", fix or remove that line in the tab it names and save again.',
];
const OVERRIDES_LIMITATION =
  'Per-card overrides in Moxfield (custom mana cost, mana value, color identity or card type) are not part of the text and are not restored.';

describe('moxfieldRestoreExport — golden', () => {
  const snapshot = buildSnapshot({
    deck: { name: 'Golden Deck', format: 'commander', description: 'Short blurb', tags: ['cEDH'] },
    zones: {
      commanders: [
        { name: 'Tymna the Weaver', printings: [{ set: 'c16', collectorNumber: '48', finish: 'foil' }] },
        { name: "Kraum, Ludevic's Opus", printings: [{ set: 'c16', collectorNumber: '34' }] },
      ],
      companions: [{ name: 'Lurrus of the Dream-Den', printings: [{ set: 'iko', collectorNumber: '226' }] }],
      mainboard: [
        { name: "Thassa's Oracle", printings: [{ set: 'thb', collectorNumber: '308', finish: 'etched' }] },
        {
          name: 'Island',
          printings: [
            { set: 'znr', collectorNumber: '271', quantity: 2 },
            { set: 'unf', collectorNumber: '235★', finish: 'foil' },
          ],
        },
        { name: 'Sol Ring', noPrintings: true },
        {
          name: 'Æther Snap',
          printings: [{ set: 'tst', collectorNumber: '9', lang: 'ja', flags: ['proxy'] }],
        },
      ],
      sideboard: [{ name: 'Orcish Bowmasters', printings: [{ set: 'ltr', collectorNumber: '103' }] }],
      tokens: [{ name: 'Treasure', printings: [{ set: 'tltr', collectorNumber: '5' }] }],
      'other:dungeon-deck': [
        { name: 'Tomb of Annihilation', printings: [{ set: 'afr', collectorNumber: '1' }] },
      ],
    },
    cardTags: { 'Sol Ring': ['ramp'] },
    primer: '# Primer\n',
  });
  const result = moxfieldRestoreExport(snapshot);

  it('emits one section per zone in canonical order', () => {
    expect(result.source).toBe('moxfield');
    expect(result.sections).toEqual([
      {
        zone: 'commanders',
        label: 'Commanders',
        kind: 'manual',
        target: 'Deck page › More › Change Commander / Add Partner',
        text: "1 Kraum, Ludevic's Opus (C16) 34\n1 Tymna the Weaver (C16) 48 *F*\n",
        cardCount: 2,
      },
      {
        zone: 'companions',
        label: 'Companion',
        kind: 'manual',
        target: 'Card menu › Set as Companion (the card must be in the Sideboard)',
        text: '1 Lurrus of the Dream-Den (IKO) 226\n',
        cardCount: 1,
      },
      {
        zone: 'mainboard',
        label: 'Mainboard',
        kind: 'paste',
        target: 'Bulk Edit › Main Deck',
        text: [
          '1 Island (UNF) 235★ *F*',
          '2 Island (ZNR) 271',
          '1 Sol Ring',
          "1 Thassa's Oracle (THB) 308 *E*",
          '1 Aether Snap (TST) 9',
          '',
        ].join('\n'),
        cardCount: 6,
      },
      {
        zone: 'sideboard',
        label: 'Sideboard',
        kind: 'paste',
        target: 'Bulk Edit › Sideboard',
        text: '1 Orcish Bowmasters (LTR) 103\n',
        cardCount: 1,
      },
      {
        zone: 'considering',
        label: 'Considering',
        kind: 'paste',
        target: 'Bulk Edit › Considering',
        text: '',
        cardCount: 0,
      },
      {
        zone: 'tokens',
        label: 'Tokens',
        kind: 'reference',
        target: 'Not restorable via Bulk Edit (the Tokens tab cannot be edited); listed for reference',
        text: '1 Treasure (TLTR) 5\n',
        cardCount: 1,
      },
      {
        zone: 'other:dungeon-deck',
        label: 'Dungeon deck',
        kind: 'reference',
        target:
          'Not restorable via Bulk Edit (Moxfield has no Bulk Edit tab for this board); listed for reference',
        text: '1 Tomb of Annihilation (AFR) 1\n',
        cardCount: 1,
      },
    ]);
  });

  it('builds the combined new-deck paste from mainboard and sideboard', () => {
    expect(result.combined).toEqual({
      text: [
        '1 Island (UNF) 235★ *F*',
        '2 Island (ZNR) 271',
        '1 Sol Ring',
        "1 Thassa's Oracle (THB) 308 *E*",
        '1 Aether Snap (TST) 9',
        '',
        'SIDEBOARD:',
        '1 Orcish Bowmasters (LTR) 103',
        '',
      ].join('\n'),
      note: 'For Create New Deck › Paste in List: set the commanders in the form, uncheck "Override with preferred printings" to keep these printings, and add Considering via Bulk Edit afterwards.',
    });
  });

  it('lists the steps in order', () => {
    expect(result.instructions).toEqual([
      'Open the deck on Moxfield and reload the page, so you edit its latest state.',
      'Set the commanders first: Deck page › More › Change Commander (use Add Partner for the second one): "Kraum, Ludevic\'s Opus" and "Tymna the Weaver".',
      'Open Bulk Edit on the deck page.',
      'In the "Main Deck" tab, select all text and replace it with the Mainboard section (6 cards).',
      'In the "Sideboard" tab, select all text and replace it with the Sideboard section (1 card).',
      'In the "Considering" tab, select all text and delete it: this version has no Considering cards.',
      'If any other Bulk Edit tab (Other › Attraction Deck, Other › Contraption Deck, Other › Sticker Sheets, Other › Planar Deck and Other › Schemes) contains cards, clear it too: this version has none there.',
      ...BULK_EDIT_STEPS_TAIL,
      'Set the companion: make sure "Lurrus of the Dream-Den" is in the Sideboard, then use its card menu › Set as Companion.',
      'Restore the primer: Deck page › Primer › Edit, select all text, paste the Primer block and save.',
      'Compare the deck name, format, description and hubs with this version and edit them by hand if they differ.',
      'Check the card counts on the deck page: Commanders 2, Companion 1, Mainboard 6, Sideboard 1, Considering 0, Tokens 1, Dungeon deck 1.',
    ]);
  });

  it('lists the limitations relevant to this snapshot', () => {
    expect(result.limitations).toEqual([
      'The deck name, format, hubs and description are not part of the pasted text and must be restored by hand.',
      'Alter and proxy markings cannot be expressed in import text; mark them again by hand: "Æther Snap".',
      'Non-English printings cannot be added via Bulk Edit; Moxfield adds these cards in English: "Æther Snap".',
      'Several printings of one card ("Island") need the "Allow multiple printings" deck preference; otherwise Moxfield keeps only one printing.',
      'No printing is recorded for "Sol Ring", so Moxfield picks its default printing.',
      'Tokens and Dungeon deck cannot be restored via Bulk Edit; those sections are for reference only.',
      "Card tags are not restored: Moxfield's data does not tell deck tags (#tag) from global tags (#!tag). Add them again by hand if needed.",
      OVERRIDES_LIMITATION,
    ]);
  });

  it('is deterministic', () => {
    expect(moxfieldRestoreExport(structuredClone(snapshot))).toEqual(result);
  });
});

describe('moxfieldRestoreExport — target deck', () => {
  const snapshot = buildSnapshot({
    zones: { commanders: ['Tymna the Weaver'], mainboard: ['Sol Ring', '3 Island'] },
    primer: '# Primer\n',
  });

  it('restores into the deck the snapshot was captured from by default', () => {
    const result = moxfieldRestoreExport(snapshot);
    expect(moxfieldRestoreExport(snapshot, 'source-deck')).toEqual(result);
    expect(result.instructions[0]).toBe(
      'Open the deck on Moxfield and reload the page, so you edit its latest state.',
    );
  });

  it('only changes the first step for a deck of the reader’s own (someone the deck was shared with)', () => {
    const source = moxfieldRestoreExport(snapshot, 'source-deck');
    const own = moxfieldRestoreExport(snapshot, 'own-deck');
    expect(own.instructions[0]).toBe(
      'Open a deck of your own on Moxfield (or create one) and reload its page, so you edit its latest state.',
    );
    expect({ ...own, instructions: own.instructions.slice(1) }).toEqual({
      ...source,
      instructions: source.instructions.slice(1),
    });
  });
});

describe('moxfieldRestoreExport — simple and empty decks', () => {
  it('only states always-relevant limitations for a plain deck', () => {
    const snapshot = buildSnapshot({
      zones: {
        mainboard: [{ name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703' }] }],
        considering: [{ name: 'Mana Crypt', printings: [{ set: 'cmm', collectorNumber: '400' }] }],
      },
    });
    const result = moxfieldRestoreExport(snapshot);
    expect(result.limitations).toEqual([
      'The deck name and format are not part of the pasted text and must be restored by hand.',
      'The combined list for a new deck does not include Considering; add it afterwards via Bulk Edit › Considering.',
      OVERRIDES_LIMITATION,
    ]);
    expect(result.combined?.text).toBe('1 Sol Ring (CMM) 703\n');
    expect(result.instructions).toEqual([
      'Open the deck on Moxfield and reload the page, so you edit its latest state.',
      'Open Bulk Edit on the deck page.',
      'In the "Main Deck" tab, select all text and replace it with the Mainboard section (1 card).',
      'In the "Sideboard" tab, select all text and delete it: this version has no Sideboard cards.',
      'In the "Considering" tab, select all text and replace it with the Considering section (1 card).',
      'If any other Bulk Edit tab (Other › Attraction Deck, Other › Contraption Deck, Other › Sticker Sheets, Other › Planar Deck and Other › Schemes) contains cards, clear it too: this version has none there.',
      ...BULK_EDIT_STEPS_TAIL,
      'This version has no primer: if the deck has one now, clear it (Deck page › Primer › Edit).',
      'Compare the deck name, format, description and hubs with this version and edit them by hand if they differ.',
      'Check the card counts on the deck page: Mainboard 1, Sideboard 0, Considering 1.',
    ]);
  });

  it('always includes empty Bulk Edit sections and has no combined text without a mainboard', () => {
    const result = moxfieldRestoreExport(buildSnapshot());
    expect(result.sections).toEqual([
      {
        zone: 'mainboard',
        label: 'Mainboard',
        kind: 'paste',
        target: 'Bulk Edit › Main Deck',
        text: '',
        cardCount: 0,
      },
      {
        zone: 'sideboard',
        label: 'Sideboard',
        kind: 'paste',
        target: 'Bulk Edit › Sideboard',
        text: '',
        cardCount: 0,
      },
      {
        zone: 'considering',
        label: 'Considering',
        kind: 'paste',
        target: 'Bulk Edit › Considering',
        text: '',
        cardCount: 0,
      },
    ]);
    expect(result.combined).toBeNull();
  });

  it('includes non-empty "Other" Bulk Edit tabs and signature spells', () => {
    const result = moxfieldRestoreExport(
      buildSnapshot({
        zones: {
          signatureSpells: [{ name: 'Lightning Bolt', printings: [{ set: 'm10', collectorNumber: '146' }] }],
          mainboard: ['Mountain'],
          attractions: [{ name: 'Balloon Stand', printings: [{ set: 'unf', collectorNumber: '201' }] }],
        },
      }),
    );
    expect(result.sections.map((s) => [s.zone, s.target])).toEqual([
      ['signatureSpells', 'Deck page › More › Change Signature Spell'],
      ['mainboard', 'Bulk Edit › Main Deck'],
      ['sideboard', 'Bulk Edit › Sideboard'],
      ['considering', 'Bulk Edit › Considering'],
      ['attractions', 'Bulk Edit › Other › Attraction Deck'],
    ]);
    expect(result.instructions).toContain(
      'Set the signature spells: Deck page › More › Change Signature Spell: "Lightning Bolt".',
    );
    expect(result.instructions).toContain(
      'In the "Other › Attraction Deck" tab, select all text and replace it with the Attractions section (1 card).',
    );
    expect(result.instructions).toContain(
      'If any other Bulk Edit tab (Other › Contraption Deck, Other › Sticker Sheets, Other › Planar Deck and Other › Schemes) contains cards, clear it too: this version has none there.',
    );
  });

  it('flags finishes Moxfield text cannot express', () => {
    const result = moxfieldRestoreExport(
      buildSnapshot({
        zones: {
          mainboard: [{ name: 'Shiny', printings: [{ set: 'sld', collectorNumber: '1', finish: 'galaxy' }] }],
        },
      }),
    );
    expect(result.sections[0]?.text).toBe('1 Shiny (SLD) 1\n');
    expect(result.limitations).toContain(
      'Finishes other than foil and etched cannot be expressed; these printings are restored as non-foil: "Shiny".',
    );
  });

  it('round-trips the v3 fixture into paste-ready sections', () => {
    const { snapshot } = normalizeMoxfieldPayload({ deck: v3Deck(), primer: v1Primer() });
    const result = moxfieldRestoreExport(snapshot);
    expect(result.sections.map((s) => s.text)).toEqual([
      "1 Kraum, Ludevic's Opus (C16) 34 *F*\n1 Tymna the Weaver (C16) 48 *F*\n",
      [
        '1 Birgi, God of Storytelling // Harnfel, Horn of Bounty (KHM) 311',
        '1 Command Tower (SLD) 1697',
        "1 Thassa's Oracle (THB) 308 *F*",
        '1 Underworld Breach (THB) 324',
        '',
      ].join('\n'),
      '',
      '1 Island (ZNR) 271\n1 Peer into the Abyss (M21) 360\n',
    ]);
  });
});

describe('moxfieldRestoreExport — primer', () => {
  it('returns the primer verbatim in Moxfield markup, so pasting it reproduces the primer', () => {
    const primer =
      "===center\n# **Blue Farm**\n===endcenter\n\n===panel: Win lines\n1. [[Thassa's Oracle]] + [[Demonic Consultation]]\n===endpanel\n";
    const result = moxfieldRestoreExport(buildSnapshot({ primer }));
    expect(result.primer).toEqual({ text: primer, target: 'Deck page › Primer › Edit' });
    expect(result.limitations.join('\n')).not.toMatch(/primer/i);
  });

  it('offers clearing the primer when the version had none', () => {
    const result = moxfieldRestoreExport(buildSnapshot({ primer: '' }));
    expect(result.primer).toEqual({ text: '', target: 'Deck page › Primer › Edit' });
    expect(result.instructions).toContain(
      'This version has no primer: if the deck has one now, clear it (Deck page › Primer › Edit).',
    );
  });

  it('cannot restore a primer that was not captured, and says so', () => {
    const result = moxfieldRestoreExport(buildSnapshot({ primer: null }));
    expect(result.primer).toBeNull();
    expect(result.instructions.join('\n')).not.toMatch(/primer/i);
    expect(result.limitations).toContain(
      'The primer was not captured for this version, so it cannot be restored from here.',
    );
  });
});

describe('moxfieldAsciiName / moxfieldCardLines', () => {
  it('applies the substitutions of Moxfield’s importer', () => {
    expect(moxfieldAsciiName('Lim-Dûl’s “Vault” – Æther… — ‚test‛ „x‟')).toBe(
      'Lim-Dûl\'s "Vault" - Aether... - \'test\' "x"',
    );
  });

  it('writes one line per printing, or a bare line without printings', () => {
    expect(
      moxfieldCardLines({
        name: 'Fire // Ice',
        quantity: 3,
        printings: [
          { set: 'mh2', collectorNumber: '290', finish: 'etched', lang: 'en', quantity: 2, ids: {} },
          { set: 'plst', collectorNumber: 'DMU-1', finish: 'nonfoil', lang: 'en', quantity: 1, ids: {} },
        ],
      }),
    ).toEqual(['2 Fire // Ice (MH2) 290 *E*', '1 Fire // Ice (PLST) DMU-1']);
    expect(moxfieldCardLines({ name: 'Island', quantity: 30, printings: [] })).toEqual(['30 Island']);
  });
});
