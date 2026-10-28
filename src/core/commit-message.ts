/**
 * Commit messages have Git's shape: a one-line subject, and optionally, after a blank
 * line, a description with more about the change. Both are stored as one string in the
 * commit (and hashed into its id); these helpers compose and read it.
 */

export interface CommitMessageParts {
  /** The first line: what lists and headings show. */
  subject: string;
  /** Everything after the first line, without the blank line before it; `''` when there is none. */
  description: string;
}

/**
 * The subject and description of a stored message. The subject is the first line
 * (trimmed); the description is the rest with its surrounding blank lines removed, line
 * breaks within it kept. A message without line breaks is all subject.
 */
export function splitCommitMessage(message: string): CommitMessageParts {
  const text = message.replace(/\r\n?/g, '\n');
  const lineBreak = text.indexOf('\n');
  if (lineBreak === -1) return { subject: text.trim(), description: '' };
  return { subject: text.slice(0, lineBreak).trim(), description: text.slice(lineBreak + 1).trim() };
}

/** The stored message of a subject and a description (`subject`, a blank line, `description`), or the subject alone. */
export function composeCommitMessage(subject: string, description: string): string {
  return description === '' ? subject : `${subject}\n\n${description}`;
}
