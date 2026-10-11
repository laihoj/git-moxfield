import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_ZONES,
  compareZones,
  isCommandZone,
  isKnownZone,
  isPlayedZone,
  isZoneId,
  KNOWN_ZONES,
  otherZone,
  sortZones,
  zoneEntries,
  zoneLabel,
  type ZoneId,
} from './zones';

describe('KNOWN_ZONES', () => {
  it('pins the canonical zone order (serialization, diffs and UI depend on it)', () => {
    expect(KNOWN_ZONES).toEqual([
      'commanders',
      'companions',
      'signatureSpells',
      'mainboard',
      'sideboard',
      'considering',
      'attractions',
      'stickers',
      'contraptions',
      'planes',
      'schemes',
      'tokens',
    ]);
  });
});

describe('compareZones / sortZones', () => {
  it('orders known zones canonically, then other zones alphabetically', () => {
    const zones: ZoneId[] = [
      'other:zeta',
      'tokens',
      'considering',
      'other:alpha',
      'mainboard',
      'commanders',
      'sideboard',
      'signatureSpells',
      'other:alpha-2',
      'companions',
    ];

    expect(sortZones(zones)).toEqual([
      'commanders',
      'companions',
      'signatureSpells',
      'mainboard',
      'sideboard',
      'considering',
      'tokens',
      'other:alpha',
      'other:alpha-2',
      'other:zeta',
    ]);
  });

  it('does not mutate its input and accepts any iterable', () => {
    const zones: ZoneId[] = ['sideboard', 'mainboard'];
    expect(sortZones(new Set(zones))).toEqual(['mainboard', 'sideboard']);
    expect(zones).toEqual(['sideboard', 'mainboard']);
  });

  it('is a consistent total order', () => {
    const zoneArb = fc.oneof(
      fc.constantFrom(...KNOWN_ZONES),
      fc.stringMatching(/^[a-z0-9]{1,4}(-[a-z0-9]{1,3})?$/).map((slug) => otherZone(slug)),
    );
    fc.assert(
      fc.property(zoneArb, zoneArb, zoneArb, (a, b, c) => {
        expect(compareZones(a, a)).toBe(0);
        expect(Math.sign(compareZones(a, b)) + Math.sign(compareZones(b, a))).toBe(0);
        expect(compareZones(a, b) === 0).toBe(a === b);
        if (compareZones(a, b) < 0 && compareZones(b, c) < 0) expect(compareZones(a, c)).toBeLessThan(0);
      }),
    );
  });
});

describe('otherZone', () => {
  it.each([
    ['foo', 'other:foo'],
    ['fooBar', 'other:foo-bar'],
    ['myCustomBoard2', 'other:my-custom-board2'],
    ['board2Go', 'other:board2-go'],
    ['Foo Bar', 'other:foo-bar'],
    ['  Foo   Bar  ', 'other:foo-bar'],
    ['foo_bar--baz', 'other:foo-bar-baz'],
    ['C\u00f4t\u00e9 Board', 'other:cote-board'], // precomposed accents
    ['Co\u0302te\u0301', 'other:cote'], // decomposed accents
    ['\u00c9tag\u00e8re', 'other:etagere'],
    ['ABC', 'other:abc'],
    ['\ufb01nal', 'other:final'], // "ﬁ" ligature, compatibility-decomposed
    ['', 'other:unnamed'],
    ['   ', 'other:unnamed'],
    ['!!!', 'other:unnamed'],
    ['\u65e5\u672c', 'other:unnamed'], // no Latin letters or digits
  ])('slugs %j as %s', (name, expected) => {
    expect(otherZone(name)).toBe(expected);
  });

  it('always produces a valid zone id', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (name) => {
        expect(isZoneId(otherZone(name))).toBe(true);
      }),
    );
  });

  it('round-trips every valid slug', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9]+(-[a-z0-9]+)*$/), (slug) => {
        expect(otherZone(slug)).toBe(`other:${slug}`);
      }),
    );
  });
});

describe('isZoneId / isKnownZone', () => {
  it('accepts known zones and well-formed other zones', () => {
    for (const zone of KNOWN_ZONES) expect(isZoneId(zone)).toBe(true);
    expect(isZoneId('other:foo')).toBe(true);
    expect(isZoneId('other:foo-bar-2')).toBe(true);
    expect(isZoneId('other:2')).toBe(true);
  });

  it.each([
    '',
    'maybeboard',
    'Mainboard',
    'other:',
    'other:Foo',
    'other:-foo',
    'other:foo-',
    'other:foo--bar',
    'other:foo bar',
    'other:foo_bar',
    'other:c\u00f4te',
    'other',
    'other:foo:bar',
  ])('rejects %j', (zone) => {
    expect(isZoneId(zone)).toBe(false);
  });

  it('distinguishes known zones from other zones', () => {
    expect(isKnownZone('mainboard')).toBe(true);
    expect(isKnownZone('other:mainboard')).toBe(false);
    expect(isKnownZone('maybeboard')).toBe(false);
  });
});

describe('zoneLabel', () => {
  it('labels known zones', () => {
    expect(KNOWN_ZONES.map(zoneLabel)).toEqual([
      'Commanders',
      'Companion',
      'Signature spells',
      'Mainboard',
      'Sideboard',
      'Considering',
      'Attractions',
      'Stickers',
      'Contraptions',
      'Planes',
      'Schemes',
      'Tokens',
    ]);
  });

  it('sentence-cases the words of other zones', () => {
    expect(zoneLabel('other:foo')).toBe('Foo');
    expect(zoneLabel('other:my-custom-board')).toBe('My custom board');
    expect(zoneLabel(otherZone('fooBar'))).toBe('Foo bar');
    expect(zoneLabel('other:unnamed')).toBe('Unnamed');
    expect(zoneLabel('other:2nd-board')).toBe('2nd board');
  });
});

describe('isPlayedZone', () => {
  it('counts commanders, companions, signature spells and mainboard as played', () => {
    expect(KNOWN_ZONES.filter(isPlayedZone)).toEqual([
      'commanders',
      'companions',
      'signatureSpells',
      'mainboard',
    ]);
    expect(isPlayedZone('other:foo')).toBe(false);
  });
});

describe('zoneEntries', () => {
  it('lists a zone-keyed map in canonical zone order, whatever its insertion order', () => {
    const map = new Map<ZoneId, number>([
      ['other:zebra', 1],
      ['sideboard', 2],
      ['commanders', 3],
      ['mainboard', 4],
    ]);
    expect(zoneEntries(map)).toEqual([
      ['commanders', 3],
      ['mainboard', 4],
      ['sideboard', 2],
      ['other:zebra', 1],
    ]);
  });

  it('copies: the map is left alone', () => {
    const map = new Map<ZoneId, string>([['sideboard', 'a']]);
    expect(zoneEntries(map)).not.toBe(zoneEntries(map));
    expect([...map]).toEqual([['sideboard', 'a']]);
  });
});

describe('the command zone', () => {
  it('is commanders, companions and signature spells, all of them played', () => {
    expect(COMMAND_ZONES).toEqual(['commanders', 'companions', 'signatureSpells']);
    for (const zone of KNOWN_ZONES) {
      expect(isCommandZone(zone)).toBe((COMMAND_ZONES as readonly string[]).includes(zone));
    }
    expect(COMMAND_ZONES.every((zone) => isPlayedZone(zone))).toBe(true);
    expect(isPlayedZone('mainboard')).toBe(true);
    expect(isCommandZone('mainboard')).toBe(false);
    expect(isCommandZone('other:contraptions')).toBe(false);
  });
});
