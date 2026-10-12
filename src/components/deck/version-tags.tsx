import { TagChip } from './tag-chip';

/**
 * A version's tags, read-only (share link viewers; the owner edits them with
 * `TagEditor`, with the same chips). Nothing when the version has none.
 */
export function VersionTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <TagChip key={tag} tag={tag} />
      ))}
    </ul>
  );
}
