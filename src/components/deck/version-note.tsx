import { RelativeTime } from '@/components/ui/relative-time';

export interface VersionNoteProps {
  /** The note's text; empty when the version has no note. */
  text: string;
  updatedAt: string | null;
}

/**
 * A version's free-text note, read-only: shown to viewers of a share link that includes
 * notes (the owner edits notes with `NotesEditor`). Rendered as plain text.
 */
export function VersionNote({ text, updatedAt }: VersionNoteProps) {
  if (text.trim() === '') return <p className="text-sm text-muted">No notes on this version.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">{text}</p>
      {updatedAt !== null && (
        <p className="text-xs text-muted">
          Updated <RelativeTime value={updatedAt} />
        </p>
      )}
    </div>
  );
}
