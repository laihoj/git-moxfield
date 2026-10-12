/**
 * Running a command-line script's `run…Command` function in a test: its output is
 * collected instead of printed.
 */
import type { CommandIO } from '../../scripts/cli';

export interface CommandRun {
  code: number;
  /** The lines written to stdout. */
  out: string[];
  /** The lines written to stderr. */
  err: string[];
}

/** Runs a command with an `io` that collects its output, and returns that and the exit code. */
export async function runCommand(run: (io: CommandIO) => Promise<number>): Promise<CommandRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run({ out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}
