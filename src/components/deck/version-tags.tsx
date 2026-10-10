/**
 * A version's tags, read-only (share link viewers; the owner edits them with
 * `TagEditor`, which looks the same). Nothing when the version has none.
 */
export function VersionTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <li
          key={tag}
          className="inline-flex h-7 items-center rounded-full bg-accent-soft px-2.5 text-sm font-medium text-accent"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}
