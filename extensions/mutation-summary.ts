/**
 * Result sentences for mutating tools.
 *
 * Claude Code states what changed in prose rather than a stat bar:
 *   ⏺ Write(/tmp/ccprobe.txt)
 *     ⎿  Wrote 1 line to ../../../../tmp/ccprobe.txt
 *   ⏺ Update(/tmp/ccprobe.txt)
 *     ⎿  Added 1 line, removed 1 line
 *
 * Grammar captured in docs/plans/2026-07-13-current-cc-grammar.md.
 */

/**
 * Claude Code bolds the counts and the path inside a result row — the numbers and
 * the file are the load-bearing facts, the surrounding words are chrome. Callers
 * that render plain text pass emphasis: (text) => text.
 */
export interface SummaryEmphasis {
	/** Wraps the parts Claude Code renders bold. */
	emphasize?: (text: string) => string;
}

const identity = (text: string): string => text;

function plural(count: number, singular: string, emphasize: (text: string) => string): string {
	return `${emphasize(String(count))} ${singular}${count === 1 ? "" : "s"}`;
}

export function describeWrite(lineCount: number, displayPath: string, options: SummaryEmphasis = {}): string {
	const emphasize = options.emphasize ?? identity;
	const lines = Math.max(0, Math.trunc(lineCount));
	return `Wrote ${plural(lines, "line", emphasize)} to ${emphasize(displayPath)}`;
}

export function describeEdit(added: number, removed: number, options: SummaryEmphasis = {}): string {
	const emphasize = options.emphasize ?? identity;
	const additions = Math.max(0, Math.trunc(added));
	const removals = Math.max(0, Math.trunc(removed));
	const clauses: string[] = [];
	if (additions > 0) clauses.push(`Added ${plural(additions, "line", emphasize)}`);
	if (removals > 0) clauses.push(`${clauses.length ? "removed" : "Removed"} ${plural(removals, "line", emphasize)}`);
	return clauses.length === 0 ? "No changes" : clauses.join(", ");
}
