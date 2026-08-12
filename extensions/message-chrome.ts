export type MessageStyle = "classic" | "claude";
export type MessageSpacing = "compact" | "comfortable";

export interface MessageChromeInput {
	messageStyle?: unknown;
	assistantPrefix?: unknown;
	thinkingPrefix?: unknown;
	messageSpacing?: unknown;
	hiddenThinkingLabel?: unknown;
}

export interface MessageChromeSettings {
	messageStyle: MessageStyle;
	assistantPrefix: string;
	thinkingPrefix: string;
	messageSpacing: MessageSpacing;
	hiddenThinkingLabel: string;
}

export interface TranscriptLineOptions {
	prefix: string;
	spacing?: MessageSpacing;
	normalizeChecks?: boolean;
	visibleWidth?: (text: string) => number;
	/**
	 * The worked line ("✻ Cooked for 8s") rides along inside the assistant text
	 * block, so it would otherwise inherit the paragraph's continuation indent.
	 * Claude Code renders it flush at column 0.
	 */
	dedentWorkedLine?: boolean;
}

// Claude Code shows no label here at all (it renders no hidden-thinking block);
// pi requires one. "Thinking..." is pi's own default — plain wording that reads as
// a fixed placeholder, not a claudify rotating-verb value. It cannot rotate: pi's
// setHiddenThinkingLabel is global across all collapsed blocks (see CLFY-26 capture,
// docs/plans/2026-07-17-cc-thinking-surfaces.md).
export const DEFAULT_HIDDEN_THINKING_LABEL = "Thinking...";

/** Claude Code prefixes user messages with ❯ and no box. */
export const DEFAULT_USER_PREFIX = "❯";

const WORKED_GLYPH = "✻";

/**
 * Claude Code names each finished turn with a past-tense cooking verb —
 * "✻ Cooked for 8s", "✻ Sautéed for 11s", "✻ Baked for 4s".
 */
export const DEFAULT_WORKED_VERBS: readonly string[] = [
	"Cooked",
	"Sautéed",
	"Baked",
	"Simmered",
	"Braised",
	"Roasted",
	"Seared",
	"Whisked",
	"Brewed",
	"Glazed",
	"Kneaded",
	"Poached",
	"Steeped",
	"Stewed",
	"Caramelized",
	"Reduced",
];

export type WorkedVerbMode = "append" | "replace";

export const MAX_CUSTOM_WORKED_VERBS = 200;
export const MAX_WORKED_VERB_LENGTH = 48;

export function sanitizeWorkedVerbs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const verbs: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const cleaned = takeGraphemes(stripControlChars(stripAnsi(item)).trim(), MAX_WORKED_VERB_LENGTH);
		if (!cleaned) continue;
		const key = cleaned.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		verbs.push(cleaned);
		if (verbs.length >= MAX_CUSTOM_WORKED_VERBS) break;
	}
	return verbs;
}

/**
 * "replace" uses only the custom verbs; "append" merges them into the built-in
 * pool. An empty custom list always falls back to the defaults, so a bad config
 * can never leave the worked line verbless.
 */
export function resolveWorkedVerbs(
	customVerbs: readonly string[] | null | undefined,
	mode: WorkedVerbMode = "append",
): readonly string[] {
	const custom = sanitizeWorkedVerbs(customVerbs ?? []);
	if (custom.length === 0) return DEFAULT_WORKED_VERBS;
	if (mode === "replace") return custom;
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const verb of [...DEFAULT_WORKED_VERBS, ...custom]) {
		const key = verb.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(verb);
	}
	return merged.length > 0 ? merged : DEFAULT_WORKED_VERBS;
}

const DEFAULT_MESSAGE_CHROME: MessageChromeSettings = {
	messageStyle: "claude",
	assistantPrefix: "⏺",
	thinkingPrefix: "✻",
	messageSpacing: "comfortable",
	hiddenThinkingLabel: DEFAULT_HIDDEN_THINKING_LABEL,
};

const ANSI_ESCAPE_SEQUENCE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const MAX_PREFIX_GRAPHEMES = 8;
const MAX_LABEL_GRAPHEMES = 80;

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_SEQUENCE_RE, "").replace(ANSI_SGR_RE, "");
}

function stripControlChars(text: string): string {
	return text.replace(CONTROL_CHARS_RE, "");
}

function takeGraphemes(text: string, max: number): string {
	return Array.from(text).slice(0, max).join("");
}

function fallbackVisibleWidth(text: string): number {
	return Array.from(stripAnsi(text)).length;
}

function isBlankLine(text: string): boolean {
	return stripAnsi(text).trim().length === 0;
}

function sanitizeTextSetting(value: unknown, fallback: string, maxGraphemes: number): string {
	if (typeof value !== "string") return fallback;
	const cleaned = takeGraphemes(stripControlChars(stripAnsi(value)).trim(), maxGraphemes);
	return cleaned || fallback;
}

export function sanitizeMessagePrefix(value: unknown, fallback: string): string {
	return sanitizeTextSetting(value, fallback, MAX_PREFIX_GRAPHEMES);
}

export function resolveMessageChromeSettings(input: MessageChromeInput = {}): MessageChromeSettings {
	const messageStyle: MessageStyle = input.messageStyle === "classic" ? "classic" : "claude";
	const messageSpacing: MessageSpacing = input.messageSpacing === "compact" ? "compact" : "comfortable";
	return {
		messageStyle,
		assistantPrefix: sanitizeMessagePrefix(input.assistantPrefix, DEFAULT_MESSAGE_CHROME.assistantPrefix),
		thinkingPrefix: sanitizeMessagePrefix(input.thinkingPrefix, DEFAULT_MESSAGE_CHROME.thinkingPrefix),
		messageSpacing,
		hiddenThinkingLabel: sanitizeTextSetting(input.hiddenThinkingLabel, DEFAULT_MESSAGE_CHROME.hiddenThinkingLabel, MAX_LABEL_GRAPHEMES),
	};
}

function normalizeTranscriptRenderedLines(lines: string[], spacing: MessageSpacing): string[] {
	let start = 0;
	while (start < lines.length && isBlankLine(lines[start])) start++;
	let end = lines.length - 1;
	while (end >= start && isBlankLine(lines[end])) end--;
	if (start > end) return [];

	const normalized: string[] = [];
	let pendingBlank = false;
	for (const line of lines.slice(start, end + 1)) {
		if (isBlankLine(line)) {
			if (spacing === "comfortable" && normalized.length > 0) pendingBlank = true;
			continue;
		}
		if (pendingBlank) {
			normalized.push("");
			pendingBlank = false;
		}
		normalized.push(line);
	}
	return normalized;
}

function normalizeLeadingCheckGlyph(line: string): string {
	return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t])*)[✓✔](?=\s)/, "$1●");
}

export function formatTranscriptLines(lines: string[], options: TranscriptLineOptions): string[] {
	const prefixGlyph = sanitizeMessagePrefix(options.prefix, DEFAULT_MESSAGE_CHROME.assistantPrefix);
	const spacing = options.spacing ?? DEFAULT_MESSAGE_CHROME.messageSpacing;
	const normalized = normalizeTranscriptRenderedLines(lines, spacing);
	const prefix = `${prefixGlyph} `;
	const measureWidth = options.visibleWidth ?? fallbackVisibleWidth;
	const continuation = " ".repeat(Math.max(1, measureWidth(prefix)));

	if (normalized.length === 0) return [prefix];

	let prefixPlaced = false;
	return normalized.map((line) => {
		const displayLine = options.normalizeChecks === false ? line : normalizeLeadingCheckGlyph(line);
		if (options.dedentWorkedLine && isWorkedLine(displayLine)) return displayLine.trimStart();
		if (!prefixPlaced && !isBlankLine(displayLine)) {
			prefixPlaced = true;
			return `${prefix}${displayLine}`;
		}
		return `${continuation}${displayLine}`;
	});
}

export interface WorkedLineOptions {
	/** Stable per-turn value so a repaint does not re-roll the verb. */
	seed?: number;
	/** Live state appended after a separator, e.g. "1 shell still running". */
	suffix?: string;
	/** Verb pool to draw from. Defaults to the built-in Claude Code pool. */
	verbs?: readonly string[];
}

/** "8s", "1m 25s", "1h 3m 5s", "2d 1h 4m". */
export function formatWorkedDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (safeMs < 60_000) {
		return `${Math.max(0, Math.floor(safeMs / 1000))}s`;
	}
	let days = Math.floor(safeMs / 86_400_000);
	let hours = Math.floor((safeMs % 86_400_000) / 3_600_000);
	let minutes = Math.floor((safeMs % 3_600_000) / 60_000);
	let seconds = Math.round((safeMs % 60_000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	if (minutes === 60) {
		minutes = 0;
		hours++;
	}
	if (hours === 24) {
		hours = 0;
		days++;
	}
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

// "8s", "1m 25s", "1h 3m 5s", "2d 1h 4m" — one or more count+unit pairs.
const WORKED_DURATION_PATTERN = "\\d+[dhms](?: \\d+[dhms])*";

/**
 * Matches a worked line under ANY verb, including user-defined ones — callers
 * strip these lines out of model context, so this must not be pinned to the
 * built-in pool. Shape-matched instead: "✻ <verb> for <duration>[ · <suffix>]".
 * Thinking rows share the ✻ glyph but never match, since they have no duration.
 */
const WORKED_LINE_RE = new RegExp(`^${WORKED_GLYPH} .+ for ${WORKED_DURATION_PATTERN}(?: · .+)?$`);

export function isWorkedLine(line: string): boolean {
	return WORKED_LINE_RE.test(stripAnsi(line).trim());
}

export function formatWorkedLine(durationMs: number, options: WorkedLineOptions = {}): string {
	const pool = options.verbs && options.verbs.length > 0 ? options.verbs : DEFAULT_WORKED_VERBS;
	const seed = Number.isFinite(options.seed) ? Math.abs(Math.trunc(options.seed as number)) : 0;
	const verb = pool[seed % pool.length];
	const line = `${WORKED_GLYPH} ${verb} for ${formatWorkedDuration(durationMs)}`;
	const suffix = typeof options.suffix === "string" ? options.suffix.trim() : "";
	return suffix ? `${line} · ${suffix}` : line;
}
