/**
 * Seeds a realistic demo deck, "Blue Farm (demo)" (Tymna the Weaver + Kraum,
 * Ludevic's Opus), with eight versions spread over the last ten weeks, tags, notes and
 * uncommitted changes on top, so every screen of git-moxfield has something to show.
 *
 *   pnpm seed:demo            seed into the app's database (TURSO_DATABASE_URL, else
 *                             DATABASE_PATH, default data/git-moxfield.db; read from the
 *                             environment and .env* files, like the app)
 *   pnpm seed:demo --force    replace an existing demo deck
 *
 * The deck belongs to the demo user, an admin named "Demo" with a workspace of its own
 * (created on first run, reused afterwards). The script ends by printing a one-time
 * recovery link (valid 24 hours) that signs a browser in as that user; its base URL is
 * `PUBLIC_APP_URL`, else http://localhost:3000. Seed a separate database
 * (`DATABASE_PATH=data/demo.db`) rather than your real one.
 *
 * How it works: the script drives the real service layer (createServices) with a
 * controllable clock. Every Moxfield state is handed over through `ingestCapture`,
 * exactly like the "Send to git-moxfield" bookmarklet does, using capture envelopes
 * built by the same builder the tests use. The deck source registry used here has
 * server fetching turned off and an in-memory fake Moxfield as its `fetch`, so seeding
 * never contacts Moxfield. The demo deck does not exist on Moxfield: when the app later
 * refreshes it, Moxfield answers with an error (or the server fetch is blocked) and
 * the deck page shows that state, which is a realistic picture of a deck you update
 * with the bookmarklet.
 */
import { parseArgs } from 'node:util';

import { createAuthService, SYSTEM_ACTOR } from '@/server/auth/service';
import { getConfig, parseConfig } from '@/server/config';
import { createLogger, type Logger } from '@/server/logger';
import { createRepositories, type Repositories, type UserRecord } from '@/server/repositories';
import { createServices, type DeckServices } from '@/server/services';
import { createDeckSourceRegistry } from '@/server/sources';
import {
  buildCaptureEnvelope,
  buildMoxfieldDeck,
  buildMoxfieldPrimer,
  FakeMoxfieldApi,
  type MoxCardSpec,
  type MoxDeckSpec,
} from '@tests/support/moxfield-deck-builder';

import { describeConfiguredDatabase, openConfiguredDatabase } from './database';
import { isEntryPoint, runMain } from './cli';
import { loadEnvFiles } from './load-env';

/** Moxfield-style public id of the demo deck (not a real Moxfield deck). */
export const DEMO_PUBLIC_ID = 'gitMoxfieldDemoBlueFarm';

/** Display name of the demo user who owns the demo deck. */
export const DEMO_USER_NAME = 'Demo';

/** Base URL printed in the sign-in link when `PUBLIC_APP_URL` is not set. */
const DEFAULT_APP_URL = 'http://localhost:3000';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

type Board = 'mainboard' | 'considering' | 'sideboard';

/** Type line and mana cost of every card the demo uses (display data for the UI). */
const CARDS: Record<string, readonly [typeLine: string, manaCost: string]> = {
  // Commanders
  'Tymna the Weaver': ['Legendary Creature — Human Cleric', '{1}{W}{B}'],
  "Kraum, Ludevic's Opus": ['Legendary Creature — Zombie Horror', '{3}{U}{R}'],
  // Lands
  'Underground Sea': ['Land — Island Swamp', ''],
  'Volcanic Island': ['Land — Island Mountain', ''],
  Tundra: ['Land — Plains Island', ''],
  Scrubland: ['Land — Plains Swamp', ''],
  Badlands: ['Land — Swamp Mountain', ''],
  Plateau: ['Land — Mountain Plains', ''],
  'Watery Grave': ['Land — Island Swamp', ''],
  'Steam Vents': ['Land — Island Mountain', ''],
  'Hallowed Fountain': ['Land — Plains Island', ''],
  'Godless Shrine': ['Land — Plains Swamp', ''],
  'Blood Crypt': ['Land — Swamp Mountain', ''],
  'Sacred Foundry': ['Land — Mountain Plains', ''],
  'Polluted Delta': ['Land', ''],
  'Flooded Strand': ['Land', ''],
  'Scalding Tarn': ['Land', ''],
  'Bloodstained Mire': ['Land', ''],
  'Marsh Flats': ['Land', ''],
  'Arid Mesa': ['Land', ''],
  'Misty Rainforest': ['Land', ''],
  'Verdant Catacombs': ['Land', ''],
  'Command Tower': ['Land', ''],
  'City of Brass': ['Land', ''],
  'Mana Confluence': ['Land', ''],
  'Ancient Tomb': ['Land', ''],
  'Gemstone Caverns': ['Legendary Land', ''],
  'Otawara, Soaring City': ['Legendary Land', ''],
  Island: ['Basic Land — Island', ''],
  Swamp: ['Basic Land — Swamp', ''],
  // Fast mana
  'Sol Ring': ['Artifact', '{1}'],
  'Mana Vault': ['Artifact', '{1}'],
  'Chrome Mox': ['Artifact', '{0}'],
  'Mox Diamond': ['Artifact', '{0}'],
  'Lotus Petal': ['Artifact', '{0}'],
  "Lion's Eye Diamond": ['Artifact', '{0}'],
  'Arcane Signet': ['Artifact', '{2}'],
  'Fellwar Stone': ['Artifact', '{2}'],
  'Talisman of Dominance': ['Artifact', '{2}'],
  'Grim Monolith': ['Artifact', '{2}'],
  'Dark Ritual': ['Instant', '{B}'],
  'Cabal Ritual': ['Instant', '{1}{B}'],
  'Rite of Flame': ['Sorcery', '{R}'],
  // Tutors
  'Demonic Tutor': ['Sorcery', '{1}{B}'],
  'Vampiric Tutor': ['Instant', '{B}'],
  'Imperial Seal': ['Sorcery', '{B}'],
  'Mystical Tutor': ['Instant', '{U}'],
  'Enlightened Tutor': ['Instant', '{W}'],
  Gamble: ['Sorcery', '{R}'],
  'Personal Tutor': ['Sorcery', '{U}'],
  'Merchant Scroll': ['Sorcery', '{1}{U}'],
  'Grim Tutor': ['Sorcery', '{1}{B}{B}'],
  'Diabolic Intent': ['Sorcery', '{1}{B}'],
  'Tainted Pact': ['Instant', '{1}{B}'],
  'Demonic Consultation': ['Instant', '{B}'],
  // Win conditions and engines
  "Thassa's Oracle": ['Creature — Merfolk Wizard', '{U}{U}'],
  'Underworld Breach': ['Enchantment', '{1}{R}'],
  'Brain Freeze': ['Instant', '{1}{U}'],
  Doomsday: ['Instant', '{B}{B}{B}'],
  'Ad Nauseam': ['Instant', '{3}{B}{B}'],
  // Card draw
  'Rhystic Study': ['Enchantment', '{2}{U}'],
  'Mystic Remora': ['Enchantment', '{U}'],
  Necropotence: ['Enchantment', '{B}{B}{B}'],
  'Gitaxian Probe': ['Sorcery', '{U/P}'],
  Gush: ['Instant', '{4}{U}'],
  Brainstorm: ['Instant', '{U}'],
  Ponder: ['Sorcery', '{U}'],
  Preordain: ['Sorcery', '{U}'],
  "Night's Whisper": ['Sorcery', '{1}{B}'],
  'Wheel of Fortune': ['Sorcery', '{2}{R}'],
  "Jeska's Will": ['Sorcery', '{2}{R}'],
  // Interaction
  'Force of Will': ['Instant', '{3}{U}{U}'],
  'Force of Negation': ['Instant', '{1}{U}{U}'],
  'Fierce Guardianship': ['Instant', '{2}{U}'],
  'Deflecting Swat': ['Instant', '{2}{R}'],
  'Pact of Negation': ['Instant', '{0}'],
  'Mental Misstep': ['Instant', '{U/P}'],
  Flusterstorm: ['Instant', '{U}'],
  'Swan Song': ['Instant', '{U}'],
  'Mindbreak Trap': ['Instant — Trap', '{2}{U}{U}'],
  'Spell Pierce': ['Instant', '{U}'],
  Counterspell: ['Instant', '{U}{U}'],
  'Mana Drain': ['Instant', '{U}{U}'],
  "An Offer You Can't Refuse": ['Instant', '{U}'],
  Pyroblast: ['Instant', '{R}'],
  'Red Elemental Blast': ['Instant', '{R}'],
  Silence: ['Instant', '{W}'],
  'Swords to Plowshares': ['Instant', '{W}'],
  'Dress Down': ['Enchantment', '{1}{U}'],
  Snap: ['Instant', '{1}{U}'],
  Stifle: ['Instant', '{U}'],
  // Creatures
  'Ragavan, Nimble Pilferer': ['Legendary Creature — Monkey Pirate', '{R}'],
  'Dauthi Voidwalker': ['Creature — Dauthi Minion', '{B}{B}'],
  'Orcish Bowmasters': ['Creature — Orc Archer', '{1}{B}'],
  'Grand Abolisher': ['Creature — Human Cleric', '{W}{W}'],
  'Drannith Magistrate': ['Creature — Human Wizard', '{1}{W}'],
  'Opposition Agent': ['Creature — Human Rogue', '{2}{B}'],
  'Esper Sentinel': ['Artifact Creature — Human Soldier', '{W}'],
  Spellseeker: ['Creature — Human Wizard', '{2}{U}'],
  'Snapcaster Mage': ['Creature — Human Wizard', '{1}{U}'],
  'Notion Thief': ['Creature — Human Rogue', '{2}{U}{B}'],
  // The "Broodlord package" (creature-based value engine, tested in v5)
  'Dark Confidant': ['Creature — Human Wizard', '{1}{B}'],
  'Professional Face-Breaker': ['Creature — Human Warrior', '{2}{R}'],
  'Scrawling Crawler': ['Artifact Creature — Phyrexian Construct', '{3}'],
  // Considering and sideboard
  'Mnemonic Betrayal': ['Sorcery', '{1}{U}{B}'],
  'Peer into the Abyss': ['Sorcery', '{4}{B}{B}{B}'],
  'Beseech the Mirror': ['Sorcery', '{1}{B}{B}{B}'],
  'Final Fortune': ['Instant', '{R}{R}'],
  'Borne Upon a Wind': ['Instant', '{1}{U}'],
  "Praetor's Grasp": ['Sorcery', '{1}{B}{B}'],
  'Culling the Weak': ['Instant', '{B}'],
  'Mox Amber': ['Legendary Artifact', '{0}'],
  "Sevinne's Reclamation": ['Sorcery', '{W}'],
  'Laboratory Maniac': ['Creature — Human Wizard', '{2}{U}'],
  Grief: ['Creature — Elemental Incarnation', '{2}{B}{B}'],
  'Snuff Out': ['Instant', '{3}{B}'],
  'Cyclonic Rift': ['Instant', '{1}{U}'],
  Windfall: ['Sorcery', '{2}{U}'],
  'Sink into Stupor // Soporific Springs': ['Instant // Land', '{1}{U}{U}'],
  'Toxic Deluge': ['Sorcery', '{2}{B}'],
  Pyroclasm: ['Sorcery', '{1}{R}'],
};

const INITIAL_MAINBOARD = [
  // Lands (28)
  ...['Underground Sea', 'Volcanic Island', 'Tundra', 'Scrubland', 'Badlands', 'Plateau'],
  ...['Watery Grave', 'Steam Vents', 'Hallowed Fountain', 'Godless Shrine', 'Blood Crypt', 'Sacred Foundry'],
  ...['Polluted Delta', 'Flooded Strand', 'Scalding Tarn', 'Bloodstained Mire', 'Marsh Flats', 'Arid Mesa'],
  ...['Misty Rainforest', 'Verdant Catacombs', 'Command Tower', 'City of Brass', 'Mana Confluence'],
  ...['Ancient Tomb', 'Gemstone Caverns', 'Otawara, Soaring City', 'Island', 'Swamp'],
  // Fast mana (13)
  ...['Sol Ring', 'Mana Vault', 'Chrome Mox', 'Mox Diamond', 'Lotus Petal', "Lion's Eye Diamond"],
  ...['Arcane Signet', 'Fellwar Stone', 'Talisman of Dominance', 'Grim Monolith'],
  ...['Dark Ritual', 'Cabal Ritual', 'Rite of Flame'],
  // Tutors (12)
  ...['Demonic Tutor', 'Vampiric Tutor', 'Imperial Seal', 'Mystical Tutor', 'Enlightened Tutor', 'Gamble'],
  ...['Personal Tutor', 'Merchant Scroll', 'Grim Tutor', 'Diabolic Intent', 'Tainted Pact'],
  'Demonic Consultation',
  // Win conditions (5)
  ...["Thassa's Oracle", 'Underworld Breach', 'Brain Freeze', 'Doomsday', 'Ad Nauseam'],
  // Card draw (11)
  ...['Rhystic Study', 'Mystic Remora', 'Necropotence', 'Gitaxian Probe', 'Gush', 'Brainstorm'],
  ...['Ponder', 'Preordain', "Night's Whisper", 'Wheel of Fortune', "Jeska's Will"],
  // Interaction (19)
  ...['Force of Will', 'Force of Negation', 'Fierce Guardianship', 'Deflecting Swat', 'Pact of Negation'],
  ...['Mental Misstep', 'Flusterstorm', 'Swan Song', 'Mindbreak Trap', 'Spell Pierce', 'Counterspell'],
  ...['Mana Drain', "An Offer You Can't Refuse", 'Pyroblast', 'Red Elemental Blast', 'Silence'],
  ...['Swords to Plowshares', 'Dress Down', 'Snap'],
  // Creatures (10)
  ...['Ragavan, Nimble Pilferer', 'Dauthi Voidwalker', 'Orcish Bowmasters', 'Grand Abolisher'],
  ...['Drannith Magistrate', 'Opposition Agent', 'Esper Sentinel', 'Spellseeker', 'Snapcaster Mage'],
  'Notion Thief',
];

const INITIAL_CONSIDERING = [
  ...['Mnemonic Betrayal', 'Peer into the Abyss', 'Beseech the Mirror', 'Final Fortune', 'Borne Upon a Wind'],
  ...["Praetor's Grasp", 'Culling the Weak', 'Mox Amber', "Sevinne's Reclamation", 'Laboratory Maniac'],
  ...['Grief', 'Snuff Out', 'Cyclonic Rift', 'Windfall', 'Sink into Stupor // Soporific Springs'],
];

const INITIAL_SIDEBOARD = ['Toxic Deluge', 'Pyroclasm', 'Stifle'];

const INITIAL_PRIMER = `===center
# Blue Farm — Tymna & Kraum

*A turbo-leaning midrange list for competitive pods.*
===endcenter

## Gameplan

Blue Farm draws cards with [[Tymna the Weaver]] and [[Kraum, Ludevic's Opus]] while holding up cheap
interaction, then wins with [[Thassa's Oracle]] or an [[Underworld Breach]] loop.

===accordion
===panel: Mulligans
Keep any seven with fast mana and a tutor. Ship hands that need three lands to function.
===endpanel
===panel: Win lines
1. [[Thassa's Oracle]] + [[Demonic Consultation]] or [[Tainted Pact]]
2. [[Underworld Breach]] + [[Lion's Eye Diamond]] + [[Brain Freeze]]
3. [[Doomsday]] piles
4. [[Ad Nauseam]] into Breach
===endpanel
===endaccordion

## Flex slots

[[Dress Down]] turns off hostile creatures such as [[Drannith Magistrate]] for the turn we go off.
`;

/** A card entry with explicit display data (the builder's object form). */
type MoxCardEntry = Exclude<MoxCardSpec, string>;

/** One Moxfield card entry: the demo's type line and mana cost for the card. */
function card(name: string): MoxCardEntry {
  const facts = CARDS[name];
  if (facts === undefined) throw new Error(`Unknown demo card: ${name}`);
  const [typeLine, manaCost] = facts;
  return { name, typeLine, manaCost };
}

/** The demo deck as it is "on Moxfield", edited step by step like a real deck. */
class DemoDeck {
  readonly boards: Record<Board, MoxCardEntry[]> = {
    mainboard: INITIAL_MAINBOARD.map(card),
    considering: INITIAL_CONSIDERING.map(card),
    sideboard: INITIAL_SIDEBOARD.map(card),
  };
  primer = INITIAL_PRIMER;
  version = 1;

  move(name: string, from: Board, to: Board): this {
    const entry = this.take(name, from);
    this.boards[to].push(entry);
    return this;
  }

  add(name: string, to: Board): this {
    this.boards[to].push(card(name));
    return this;
  }

  /** Replaces a card's entry (e.g. a new printing). */
  replace(name: string, board: Board, entry: MoxCardEntry): this {
    this.take(name, board);
    this.boards[board].push(entry);
    return this;
  }

  editPrimer(edit: (primer: string) => string): this {
    const edited = edit(this.primer);
    if (edited === this.primer) throw new Error('Primer edit had no effect');
    this.primer = edited;
    return this;
  }

  spec(lastUpdatedAt: Date): MoxDeckSpec {
    const played = 2 + this.boards.mainboard.length;
    if (played !== 100) throw new Error(`The demo deck must have 100 cards, has ${played}`);
    return {
      publicId: DEMO_PUBLIC_ID,
      name: 'Blue Farm (demo)',
      description: 'Demo deck seeded by git-moxfield. Tymna/Kraum Blue Farm for cEDH.',
      format: 'commander',
      version: this.version,
      lastUpdatedAtUtc: lastUpdatedAt.toISOString(),
      hubs: ['cEDH', 'Turbo'],
      commanders: [card('Tymna the Weaver'), card("Kraum, Ludevic's Opus")],
      mainboard: [...this.boards.mainboard],
      considering: [...this.boards.considering],
      sideboard: [...this.boards.sideboard],
      authorTags: { 'Dress Down': ['flex'], 'Mnemonic Betrayal': ['flex'], "Thassa's Oracle": ['win-con'] },
      primer: this.primer,
    };
  }

  private take(name: string, from: Board): MoxCardEntry {
    const index = this.boards[from].findIndex((entry) => entry.name === name);
    const [entry] = index === -1 ? [] : this.boards[from].splice(index, 1);
    if (entry === undefined) throw new Error(`${name} is not in ${from}`);
    return entry;
  }
}

interface DemoVersion {
  day: number;
  message: string;
  method?: 'browser-capture' | 'manual-paste';
  tags?: string[];
  note?: string;
  edit?: (deck: DemoDeck) => void;
}

const VERSIONS: DemoVersion[] = [
  { day: 0, message: 'Initial version' },
  {
    day: 6,
    message: 'Swap Dress Down for Mnemonic Betrayal',
    edit: (deck) =>
      deck
        .move('Dress Down', 'mainboard', 'considering')
        .move('Mnemonic Betrayal', 'considering', 'mainboard')
        .editPrimer((primer) =>
          primer.replace(
            '4. [[Ad Nauseam]] into Breach',
            '4. [[Ad Nauseam]] into Breach\n5. [[Mnemonic Betrayal]] after a wheel, then Breach from the graveyard',
          ),
        ),
  },
  {
    day: 13,
    message: "Beseech the Mirror over Night's Whisper",
    tags: ['tournament'],
    note: 'Local cEDH night (12 players): 3-1-1, lost the final to Kinnan. Mnemonic Betrayal won one game on its own.',
    edit: (deck) =>
      deck
        .move('Beseech the Mirror', 'considering', 'mainboard')
        .move("Night's Whisper", 'mainboard', 'considering'),
  },
  {
    day: 20,
    message: 'Foil Force of Will',
    tags: ['stable'],
    edit: (deck) =>
      deck.replace('Force of Will', 'mainboard', {
        ...card('Force of Will'),
        set: 'tst',
        collectorNumber: '51',
        finish: 'foil',
      }),
  },
  {
    day: 31,
    message: 'Testing Broodlord package',
    method: 'manual-paste',
    tags: ['testing'],
    edit: (deck) =>
      deck
        .add('Dark Confidant', 'mainboard')
        .add('Professional Face-Breaker', 'mainboard')
        .add('Scrawling Crawler', 'mainboard')
        .move('Spellseeker', 'mainboard', 'considering')
        .move('Notion Thief', 'mainboard', 'considering')
        .move('Gamble', 'mainboard', 'considering')
        .editPrimer(
          (primer) =>
            `${primer}\n## Testing: creature package\n\n[[Dark Confidant]], [[Professional Face-Breaker]] and [[Scrawling Crawler]] replace the slower tutors this week.\n`,
        ),
  },
  {
    day: 38,
    message: 'Back to lower creature count',
    edit: (deck) =>
      deck
        .move('Dark Confidant', 'mainboard', 'considering')
        .move('Professional Face-Breaker', 'mainboard', 'considering')
        .move('Scrawling Crawler', 'mainboard', 'considering')
        .move('Spellseeker', 'considering', 'mainboard')
        .move('Notion Thief', 'considering', 'mainboard')
        .move('Gamble', 'considering', 'mainboard')
        .editPrimer((primer) =>
          primer.replace(
            /## Testing: creature package\n\n.*\n/,
            '## Creature package (retired)\n\nThe creature package drew well but folded to every sweeper. Back to tutors.\n',
          ),
        ),
  },
  {
    day: 52,
    message: 'Dress Down back in over Mental Misstep',
    edit: (deck) =>
      deck.move('Dress Down', 'considering', 'mainboard').move('Mental Misstep', 'mainboard', 'considering'),
  },
  {
    day: 63,
    message: 'Regional list: Stifle main',
    tags: ['tournament', 'stable'],
    note: 'Regional 1K (64 players): 5-2-1, top 16. Rhystic Study overperformed; never cast Peer into the Abyss.',
    edit: (deck) =>
      deck
        .move('Stifle', 'sideboard', 'mainboard')
        .move('Spell Pierce', 'mainboard', 'sideboard')
        .editPrimer((primer) =>
          primer.replace(
            'Keep any seven with fast mana and a tutor.',
            'Keep any seven with fast mana and a tutor, or two pieces of interaction and a land.',
          ),
        ),
  },
];

/** The uncommitted state left on "Moxfield" at the end, so the deck page shows a diff. */
function uncommittedEdits(deck: DemoDeck): void {
  deck
    .move('Final Fortune', 'considering', 'mainboard')
    .move('Wheel of Fortune', 'mainboard', 'considering')
    .editPrimer((primer) =>
      primer.replace(
        '3. [[Doomsday]] piles',
        '3. [[Doomsday]] piles\n4. [[Final Fortune]] protects a Breach turn through removal',
      ),
    );
}

/**
 * The demo user: the admin named {@link DEMO_USER_NAME}, created with a workspace of its
 * own when there is none. (It never adopts the `local` workspace of a pre-account
 * installation, so seeding a real database cannot take over its history.)
 */
export async function ensureDemoUser(repos: Repositories): Promise<UserRecord> {
  const existing = (await repos.users.findByDisplayName(DEMO_USER_NAME)).find(
    (user) => user.role === 'admin',
  );
  if (existing) return existing.disabledAt === null ? existing : repos.users.setDisabled(existing.id, false);
  return repos.users.create({ displayName: DEMO_USER_NAME, role: 'admin' });
}

/** A clock the seed moves forward explicitly; the services must be created with its `now`. */
export class DemoClock {
  constructor(private ms: number) {}
  readonly now = (): Date => new Date(this.ms);
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Services log info lines for every capture and commit; keep the script's output short. */
function quietLogger(): Logger {
  const logger = createLogger('seed-demo');
  return { ...logger, debug: () => undefined, info: () => undefined };
}

/**
 * Hands the deck's current state to git-moxfield like a user would: the bookmarklet's
 * capture envelope, or the two API responses pasted into /capture?mode=paste.
 */
async function capture(
  services: DeckServices,
  deck: DemoDeck,
  clock: DemoClock,
  method: 'browser-capture' | 'manual-paste',
): Promise<string> {
  // Edited on Moxfield 25 minutes before it was sent to git-moxfield.
  const spec = deck.spec(new Date(clock.now().getTime() - 25 * MINUTE_MS));
  const data =
    method === 'browser-capture'
      ? buildCaptureEnvelope(spec, clock.now().toISOString())
      : { deck: JSON.stringify(buildMoxfieldDeck(spec)), primer: JSON.stringify(buildMoxfieldPrimer(spec)) };
  const outcome = await services.ingestCapture({ data, method, track: true });
  if (outcome.status !== 'ingested') throw new Error('The demo capture was not ingested');
  return outcome.deckId;
}

/**
 * Creates the demo deck through `services`: eight versions over the ten weeks before
 * `end` (epoch ms), with tags and notes, then leaves uncommitted changes on top. The
 * services must use `clock.now` as their clock. Returns the deck id.
 */
export async function seedDemoDeck(services: DeckServices, clock: DemoClock, end: number): Promise<string> {
  // Midnight UTC ten weeks ago; versions are committed in the (UTC) evening.
  const start = Math.floor(end / DAY_MS) * DAY_MS - 70 * DAY_MS;
  const deck = new DemoDeck();
  let deckId = '';
  for (const [index, version] of VERSIONS.entries()) {
    clock.set(start + version.day * DAY_MS + (18 + (index % 4)) * 60 * MINUTE_MS);
    if (index > 0) {
      deck.version += 1 + (index % 3);
      version.edit?.(deck);
    }
    deckId = await capture(services, deck, clock, version.method ?? 'browser-capture');

    clock.advance(3 * MINUTE_MS);
    const overview = await services.getOverview(deckId);
    if (!overview?.working) throw new Error('The demo deck has no working state');
    const outcome = await services.commit(deckId, {
      message: version.message,
      expectedObservationId: overview.working.id,
      expectedHeadCommitId: overview.head?.commitId ?? null,
      ...(version.tags ? { tags: version.tags } : {}),
    });
    if (!outcome.ok) throw new Error(`Committing "${version.message}" failed: ${outcome.message}`);
    if (version.note !== undefined) await services.setNote(deckId, outcome.version.sequence, version.note);
  }

  clock.set(end - 2 * 60 * MINUTE_MS);
  deck.version += 2;
  uncommittedEdits(deck);
  await capture(services, deck, clock, 'browser-capture');
  return deckId;
}

async function main(): Promise<number> {
  let force: boolean;
  try {
    force = parseArgs({ options: { force: { type: 'boolean', default: false } } }).values.force;
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\nUsage: pnpm seed:demo [--force]`,
    );
    return 1;
  }
  loadEnvFiles();
  const appConfig = getConfig();
  const api = new FakeMoxfieldApi();
  const config = parseConfig({
    ...process.env,
    MOXFIELD_API_BASE_URL: api.apiBaseUrl,
    MOXFIELD_SERVER_FETCH: 'off',
  });
  const logger = quietLogger();
  const end = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const clock = new DemoClock(end);

  const where = describeConfiguredDatabase(appConfig);
  const database = await openConfiguredDatabase(appConfig);
  const { db } = database;
  try {
    const demoUser = await ensureDemoUser(createRepositories(db));
    const services = createServices({
      db,
      sources: createDeckSourceRegistry(config, { fetchImpl: api.fetch, logger }),
      config,
      workspaceId: demoUser.workspaceId,
      now: clock.now,
      logger,
    });

    const existing = (await services.listDecks()).find(
      (deck) => deck.source === 'moxfield' && deck.externalId === DEMO_PUBLIC_ID,
    );
    if (existing) {
      if (!force) {
        console.error(
          `The demo deck already exists at /decks/${existing.id} in the ${where}. Run with --force to replace it.`,
        );
        return 1;
      }
      await services.untrackDeck(existing.id);
      console.log('Removed the existing demo deck.');
    }

    const deckId = await seedDemoDeck(services, clock, end);
    const overview = await services.getOverview(deckId);
    console.log(
      `Seeded "${overview?.name ?? 'Blue Farm (demo)'}" with ${overview?.versionCount ?? 0} versions (status: ${overview?.status ?? 'unknown'}) into the ${where}.`,
    );
    console.log(`/decks/${deckId}`);

    // Signs a browser in as the demo user (the real clock: the link must be valid now).
    const auth = createAuthService({ db, config: appConfig, logger });
    const link = await auth.createRecoveryLink(SYSTEM_ACTOR, demoUser.id);
    const appUrl = appConfig.PUBLIC_APP_URL ?? DEFAULT_APP_URL;
    console.log(
      `\nSign in as the demo user "${demoUser.displayName}" with this one-time link (valid until ${link.expiresAt}):`,
    );
    console.log(new URL(link.path, appUrl).href);
    return 0;
  } finally {
    database.close();
  }
}

// Run only as a script (`pnpm seed:demo`), not when imported by tests.
if (isEntryPoint(import.meta.url)) runMain('seed-demo', main);
