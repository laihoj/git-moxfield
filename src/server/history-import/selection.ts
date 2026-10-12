/**
 * What an import reads and where it writes: the source workspace (whose decks), the target
 * user (whose workspace receives them) and an optional subset of decks.
 */
import 'server-only';

import { pluralize } from '@/core/text';
import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import { parseDeckReference } from '@/server/deck-reference';
import type { DeckRecord, Repositories, UserRecord } from '@/server/repositories';

import { HistoryImportError } from './errors';

/** A workspace of the source database that holds decks. */
export interface SourceWorkspace {
  id: string;
  /** Its owner, or `null` for the `local` workspace of an installation nobody claimed. */
  owner: Pick<UserRecord, 'id' | 'displayName' | 'role'> | null;
  deckCount: number;
}

/** Which source workspace an import reads, and why. */
export interface SourceWorkspaceChoice {
  workspace: SourceWorkspace;
  /**
   * How it was chosen: named with `--from-workspace`, the `local` workspace (the history of
   * an installation from before accounts, which its first admin adopts when claiming it),
   * or the first admin's (who claimed an installation without such history).
   */
  reason: 'named' | 'local' | 'first-admin';
  /** The source's other workspaces with decks, which this import leaves out. */
  others: SourceWorkspace[];
}

/** Every workspace of the source that holds decks, with owner and deck count, by owner name. */
async function workspacesWithDecks(repos: Repositories): Promise<SourceWorkspace[]> {
  const [decks, users] = await Promise.all([repos.workspaces.locateAllDecks(), repos.users.list()]);
  const owners = new Map(users.map((user) => [user.workspaceId, user]));
  const counts = new Map<string, number>();
  for (const deck of decks) counts.set(deck.workspaceId, (counts.get(deck.workspaceId) ?? 0) + 1);
  return [...counts].map(([id, deckCount]) => {
    const owner = owners.get(id);
    return {
      id,
      owner: owner === undefined ? null : { id: owner.id, displayName: owner.displayName, role: owner.role },
      deckCount,
    };
  });
}

/** `"local" (Jaakko, admin): 3 decks`, for listing workspaces to the operator. */
export function describeSourceWorkspace(workspace: SourceWorkspace): string {
  const owner =
    workspace.owner === null ? 'no owner' : `${workspace.owner.displayName}, ${workspace.owner.role}`;
  return `workspace ${workspace.id} (${owner}): ${pluralize(workspace.deckCount, 'deck')}`;
}

/**
 * Chooses the source workspace: `named` (a workspace id, a user id or a user's display
 * name) when given, otherwise the `local` workspace when it holds decks, otherwise the
 * first (oldest) admin's workspace when it does.
 *
 * Why these two: a database from before accounts keeps every deck in `local`, and its
 * first admin adopts `local` when claiming it, so for a single-user installation both
 * name the same decks. The first admin's own workspace is the fallback for an
 * installation that was claimed before any deck was tracked.
 *
 * @throws {HistoryImportError} when the named workspace or user does not exist, a name is
 *   ambiguous, or nothing is chosen (the message lists the workspaces with decks).
 */
export async function chooseSourceWorkspace(
  repos: Repositories,
  named?: string,
): Promise<SourceWorkspaceChoice> {
  const candidates = await workspacesWithDecks(repos);
  const listing = (): string =>
    candidates.length === 0
      ? 'The source database has no decks.'
      : `Workspaces with decks:\n${candidates.map((workspace) => `  ${describeSourceWorkspace(workspace)}`).join('\n')}`;
  const choose = (
    workspace: SourceWorkspace,
    reason: SourceWorkspaceChoice['reason'],
  ): SourceWorkspaceChoice => ({
    workspace,
    reason,
    others: candidates.filter((candidate) => candidate.id !== workspace.id),
  });

  if (named !== undefined) {
    const wanted = named.trim();
    const byWorkspace = candidates.find((workspace) => workspace.id === wanted);
    if (byWorkspace) return choose(byWorkspace, 'named');
    const byId = await repos.users.getById(wanted);
    const matches = byId ? [byId] : await repos.users.findByDisplayName(wanted);
    if (matches.length > 1) {
      throw new HistoryImportError(
        `Several users of the source are called ${JSON.stringify(named)}; name the workspace by its id. ${listing()}`,
      );
    }
    const user = matches[0];
    const workspace = user && candidates.find((candidate) => candidate.id === user.workspaceId);
    if (user && workspace) return choose(workspace, 'named');
    throw new HistoryImportError(
      user
        ? `${user.displayName}'s workspace in the source has no decks. ${listing()}`
        : `The source has no workspace or user ${JSON.stringify(named)} with decks. ${listing()}`,
    );
  }

  const local = candidates.find((workspace) => workspace.id === LOCAL_WORKSPACE_ID);
  if (local) return choose(local, 'local');
  const firstAdmin = (await repos.users.list()).find((user) => user.role === 'admin');
  const admins = firstAdmin && candidates.find((workspace) => workspace.id === firstAdmin.workspaceId);
  if (admins) return choose(admins, 'first-admin');
  throw new HistoryImportError(
    `Neither the source's local workspace nor its first admin's holds decks. Choose one with --from-workspace. ${listing()}`,
  );
}

/**
 * The target user: by id, else by display name (ignoring case).
 * @throws {HistoryImportError} for an unknown or ambiguous user (the message lists users).
 */
export async function findTargetUser(repos: Repositories, who: string): Promise<UserRecord> {
  const wanted = who.trim();
  const byId = await repos.users.getById(wanted);
  if (byId) return byId;
  const matches = await repos.users.findByDisplayName(wanted);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  const users = await repos.users.list();
  const listing =
    users.length === 0
      ? 'The target has no users yet: claim it (or create an invite with `pnpm users invite`) first.'
      : `Users:\n${users.map((user) => `  ${user.id}  ${user.displayName}  ${user.role}`).join('\n')}`;
  throw new HistoryImportError(
    matches.length > 1
      ? `Several users of the target are called ${JSON.stringify(who)}; pass the user id. ${listing}`
      : `The target has no user ${JSON.stringify(who)}. ${listing}`,
  );
}

/**
 * The source decks `filters` name (a git-moxfield deck id, a Moxfield public id or a
 * Moxfield deck URL on one of `siteOrigins`), in the order given, without duplicates.
 * @throws {HistoryImportError} for a filter that names no deck of the source workspace
 *   (the message lists them).
 */
export async function selectSourceDecks(
  repos: Repositories,
  filters: readonly string[],
  siteOrigins: readonly string[],
): Promise<DeckRecord[]> {
  const decks = await repos.decks.list();
  if (filters.length === 0) return decks;
  const chosen = new Map<string, DeckRecord>();
  for (const filter of filters) {
    const reference = parseDeckReference(filter, siteOrigins);
    // Leniently, any source's external id counts as well as a valid Moxfield one.
    let deck = decks.find(
      (candidate) => candidate.id === reference?.id || candidate.externalId === reference?.id,
    );
    if (!deck && reference?.moxfield) {
      const { source, externalId } = reference.moxfield;
      deck = decks.find((candidate) => candidate.source === source && candidate.externalId === externalId);
    }
    if (!deck) {
      throw new HistoryImportError(
        `The source workspace has no deck ${JSON.stringify(filter)}. Its decks:\n` +
          decks.map((candidate) => `  ${candidate.externalId}  ${candidate.name}`).join('\n'),
      );
    }
    chosen.set(deck.id, deck);
  }
  return [...chosen.values()];
}
