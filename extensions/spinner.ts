import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";

import { readSettings } from "./settings.ts";

// ---------------------------------------------------------------------------
// Patch built-in Loader with Claude/OpenBrawd-style glyphs.
// Keep animation cadence constant so the spinner doesn't appear to slow down
// or freeze as the session grows.
// ---------------------------------------------------------------------------

const RAW_ANSI_RE = /\x1b\[[0-9;]*m/;
const RESET = "\x1b[0m";

// Defaults match the previous hardcoded values so behavior is identical
// when no theme is available or themeAdaptive=false. `applyThemeColors`
// below re-derives them from the active pi theme each tick.
let CLAUDE_ORANGE = "\x1b[38;2;215;119;87m";
let STATUS_DIM = "\x1b[38;2;153;153;153m";

// Short TTL so Claudify screen spinner changes are picked up within ~1s
// without re-reading the file on every 250ms spinner tick.
type SpinnerVerbMode = "append" | "replace";
interface SpinnerSettings {
	adaptive: boolean;
	verbColor: string;
	statusColor: string;
	verbs: readonly string[];
	shimmer: boolean;
}

let _spinnerSettingsCache: { value: SpinnerSettings; expires: number } | null = null;
const SPINNER_SETTINGS_TTL_MS = 1_000;
export const MAX_CUSTOM_SPINNER_VERBS = 200;
export const MAX_SPINNER_VERB_LENGTH = 48;
const ANSI_ESCAPE_SEQUENCE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;
// Cross-extension bust signal: the Claudify screen in index.ts bumps this
// counter and we drop the cache when it changes.
const SPINNER_BUST_KEY = Symbol.for("pi-claudify:spinner-settings-bust");
const SPINNER_COLOR_PREVIEW_KEY = Symbol.for("pi-claudify:spinner-color-preview");
const SPINNER_STATUS_COLOR_PREVIEW_KEY = Symbol.for("pi-claudify:spinner-status-color-preview");
let _spinnerLastBust = 0;

function sanitizeSpinnerVerb(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value
		.replace(ANSI_ESCAPE_SEQUENCE_RE, "")
		.replace(CONTROL_CHARS_RE, "")
		.trim();
	if (!cleaned) return null;
	return Array.from(cleaned).slice(0, MAX_SPINNER_VERB_LENGTH).join("");
}

export function sanitizeSpinnerVerbs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const verbs: string[] = [];
	for (const item of value) {
		const verb = sanitizeSpinnerVerb(item);
		if (!verb) continue;
		const key = verb.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		verbs.push(verb);
		if (verbs.length >= MAX_CUSTOM_SPINNER_VERBS) break;
	}
	return verbs;
}

export function resolveSpinnerVerbs(customVerbs: readonly string[] | null, mode: SpinnerVerbMode): readonly string[] {
	if (!customVerbs || customVerbs.length === 0) return DEFAULT_SPINNER_VERBS;
	if (mode === "replace") return customVerbs;
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const verb of [...DEFAULT_SPINNER_VERBS, ...customVerbs]) {
		const key = verb.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(verb);
	}
	return merged.length > 0 ? merged : DEFAULT_SPINNER_VERBS;
}

function readSpinnerSettings(): SpinnerSettings {
	const now = Date.now();
	const bust = ((globalThis as any)[SPINNER_BUST_KEY] as number | undefined) ?? 0;
	if (bust !== _spinnerLastBust) {
		_spinnerLastBust = bust;
		_spinnerSettingsCache = null;
	}
	if (_spinnerSettingsCache && _spinnerSettingsCache.expires > now) {
		return _spinnerSettingsCache.value;
	}
	const raw = readSettings().values;
	const adaptive = raw.themeAdaptive !== false;
	const spinnerPreview = (globalThis as any)[SPINNER_COLOR_PREVIEW_KEY];
	const statusPreview = (globalThis as any)[SPINNER_STATUS_COLOR_PREVIEW_KEY];
	// Spinner glyph and verb share one theme color so they read as a single working indicator.
	const verbColor = typeof spinnerPreview === "string" && spinnerPreview.length > 0
		? spinnerPreview
		: typeof raw.spinnerColor === "string" && raw.spinnerColor.length > 0
			? raw.spinnerColor
			: "borderAccent";
	const statusColor = typeof statusPreview === "string" && statusPreview.length > 0
		? statusPreview
		: typeof raw.spinnerStatusColor === "string" && raw.spinnerStatusColor.length > 0
			? raw.spinnerStatusColor
			: "muted";
	const customVerbs = Array.isArray(raw.spinnerVerbs) ? sanitizeSpinnerVerbs(raw.spinnerVerbs) : null;
	const verbMode: SpinnerVerbMode = raw.spinnerVerbMode === "replace" ? "replace" : "append";
	// CC's warm shimmer imposes its own fixed palette, so it only applies when the
	// spinner is at its default color — a custom spinnerColor (or a live preview of
	// one) means the user picked a static color and wins. Opt-out via spinnerShimmer.
	const shimmer = raw.spinnerShimmer !== false && verbColor === "borderAccent";
	const value: SpinnerSettings = {
		adaptive,
		verbColor,
		statusColor,
		verbs: resolveSpinnerVerbs(customVerbs, verbMode),
		shimmer,
	};
	_spinnerSettingsCache = { value, expires: now + SPINNER_SETTINGS_TTL_MS };
	return value;
}

// Original Claude-style values restored when the user turns adaptive off.
const _DEFAULT_CLAUDE_ORANGE = "\x1b[38;2;215;119;87m";
const _DEFAULT_STATUS_DIM = "\x1b[38;2;153;153;153m";

let _themeColorsCacheTheme: unknown = null;
let _themeColorsLastAdaptive: boolean | null = null;
let _themeColorsLastVerbKey: string | null = null;
let _themeColorsLastStatusKey: string | null = null;

function resolveThemeColor(theme: any, key: string, fallbackKey: string): string | null {
	if (!theme || typeof theme.getFgAnsi !== "function") return null;
	try {
		const v = theme.getFgAnsi(key);
		if (typeof v === "string" && v.length > 0) return v;
	} catch { /* ignore */ }
	if (fallbackKey !== key) {
		try {
			const v = theme.getFgAnsi(fallbackKey);
			if (typeof v === "string" && v.length > 0) return v;
		} catch { /* ignore */ }
	}
	return null;
}

// ---------------------------------------------------------------------------
// CLFY-27: Claude Code's thinking-spinner shimmer, extended to a continuous loop.
// The warm hue escalation (salmon → gold) is captured from CC
// (docs/plans/2026-07-17-cc-thinking-surfaces.md); CC then freezes at gold.
// Claudify deliberately diverges (Berto's call): the animation never stops — on
// top of the escalated base color it alternates a right→left sweep with a
// whole-verb "breathing" pulse, forever. pi repaints on every setWorkingMessage
// (setMessage → updateDisplay → requestRender), so this animates at the refresh
// cadence, independent of the 500ms glyph timer.
const SHIMMER_BOLD = "\x1b[1m";

interface Rgb { readonly r: number; readonly g: number; readonly b: number; }
interface ShimmerStop { readonly atMs: number; readonly rgb: Rgb; readonly bold: boolean; }
// Warm escalation, keyed to elapsed seconds (captured at effort=high on CC 2.1.212).
const SHIMMER_STOPS: readonly ShimmerStop[] = [
	{ atMs: 0, rgb: { r: 215, g: 135, b: 135 }, bold: false }, // #D78787 salmon
	{ atMs: 13_000, rgb: { r: 215, g: 175, b: 135 }, bold: false }, // #D7AF87 tan
	{ atMs: 14_000, rgb: { r: 215, g: 175, b: 95 }, bold: false }, // #D7AF5F
	{ atMs: 15_000, rgb: { r: 255, g: 175, b: 95 }, bold: false }, // #FFAF5F orange
	{ atMs: 17_000, rgb: { r: 255, g: 175, b: 95 }, bold: true }, // + bold
	{ atMs: 20_000, rgb: { r: 255, g: 215, b: 0 }, bold: true }, // #FFD700 gold
];
// A bright warm cream highlight — more legible than CC's one-shade delta.
const SHIMMER_SWEEP_RGB: Rgb = { r: 255, g: 215, b: 175 }; // #FFD7AF

// One animation super-cycle: a sweep pass, then a breathing stretch, repeating.
const SHIMMER_SWEEP_MS = 4_000;
const SHIMMER_BREATHE_MS = 3_200;
const SHIMMER_CYCLE_MS = SHIMMER_SWEEP_MS + SHIMMER_BREATHE_MS;
const SHIMMER_SWEEP_STEP_MS = 200; // ~5 char-steps/s
const SHIMMER_BREATH_PERIOD_MS = 1_600;
const SHIMMER_BREATHE_MIN = 0.55; // dimmest fraction of base brightness within a breath
// Refresh cadence while the animation runs — smooth enough for the sweep + breath.
export const SHIMMER_REFRESH_MS = 200;

function rgbAnsi({ r, g, b }: Rgb): string {
	return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
}
function scaleRgb({ r, g, b }: Rgb, factor: number): Rgb {
	return { r: r * factor, g: g * factor, b: b * factor };
}

/** Base verb/glyph color (RGB) + bold for the elapsed time — the one-way "wave". */
export function shimmerBaseRgb(elapsedMs: number): { rgb: Rgb; bold: boolean } {
	let stop = SHIMMER_STOPS[0];
	for (const candidate of SHIMMER_STOPS) {
		if (elapsedMs >= candidate.atMs) stop = candidate;
		else break;
	}
	return { rgb: stop.rgb, bold: stop.bold };
}

/** Which overlay is active now — the sweep, or the breathing pulse. They alternate forever. */
export function shimmerPhase(elapsedMs: number): "sweep" | "breathe" {
	return (elapsedMs % SHIMMER_CYCLE_MS) < SHIMMER_SWEEP_MS ? "sweep" : "breathe";
}

/** Brightness fraction of the breathing pulse: 1.0 (bright) dipping to SHIMMER_BREATHE_MIN and back. 1.0 during the sweep phase. */
export function shimmerBreatheFactor(elapsedMs: number): number {
	const pos = ((elapsedMs % SHIMMER_CYCLE_MS) + SHIMMER_CYCLE_MS) % SHIMMER_CYCLE_MS;
	if (pos < SHIMMER_SWEEP_MS) return 1;
	const t = (pos - SHIMMER_SWEEP_MS) % SHIMMER_BREATH_PERIOD_MS;
	const dip = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / SHIMMER_BREATH_PERIOD_MS); // 0 → 1 → 0
	return 1 - (1 - SHIMMER_BREATHE_MIN) * dip;
}

/** Inclusive [start,end] char indices of the sweep highlight, or null (breathe phase / pass complete). */
export function shimmerSweep(verbLen: number, elapsedMs: number): { start: number; end: number } | null {
	if (verbLen <= 0 || elapsedMs < 0) return null;
	const pos = elapsedMs % SHIMMER_CYCLE_MS;
	if (pos >= SHIMMER_SWEEP_MS) return null; // breathing, not sweeping
	const step = Math.floor(pos / SHIMMER_SWEEP_STEP_MS);
	if (step >= verbLen) return null; // pass complete — hold uniform until the breathe phase
	const center = verbLen - 1 - step; // right → left
	return { start: Math.max(0, center - 1), end: Math.min(verbLen - 1, center + 1) };
}

/** Wrap the verb in the escalated base color (breathing when in that phase) with the sweep highlight. */
export function colorizeShimmerVerb(verb: string, elapsedMs: number): string {
	const chars = Array.from(verb);
	const { rgb, bold } = shimmerBaseRgb(elapsedMs);
	const boldSeq = bold ? SHIMMER_BOLD : "";
	const baseAnsi = rgbAnsi(scaleRgb(rgb, shimmerBreatheFactor(elapsedMs)));
	const sweep = shimmerSweep(chars.length, elapsedMs);
	if (!sweep) return `${boldSeq}${baseAnsi}${verb}${RESET}`;
	const hlAnsi = rgbAnsi(SHIMMER_SWEEP_RGB);
	let out = boldSeq;
	for (let i = 0; i < chars.length; i++) {
		out += (i >= sweep.start && i <= sweep.end ? hlAnsi : baseAnsi) + chars[i];
	}
	return `${out}${RESET}`;
}

/** Leading-glyph color — the breathed base (+bold), matching the verb. */
export function shimmerGlyphAnsi(elapsedMs: number): string {
	const { rgb, bold } = shimmerBaseRgb(elapsedMs);
	const ansi = rgbAnsi(scaleRgb(rgb, shimmerBreatheFactor(elapsedMs)));
	return `${bold ? SHIMMER_BOLD : ""}${ansi}`;
}

// Shared with the extension closure below: the anchor timestamp of the active
// spell (0 = inactive) and whether shimmer is enabled. updateDisplay (a Loader
// prototype method) reads these; the extension writes them on turn boundaries.
let _shimmerAnchorMs = 0;
let _shimmerEnabled = false;
export function shimmerElapsedMs(): number {
	return _shimmerAnchorMs > 0 ? Date.now() - _shimmerAnchorMs : -1;
}
function shimmerActive(): boolean {
	return _shimmerEnabled && _shimmerAnchorMs > 0;
}

function applyThemeColors(theme: any): void {
	const settings = readSpinnerSettings();
	const { adaptive, verbColor, statusColor } = settings;
	_shimmerEnabled = settings.shimmer;

	// Respond to runtime toggles (themeAdaptive or spinner color key changes)
	// without restarting pi.
	const settingsChanged = _themeColorsLastAdaptive !== adaptive
		|| _themeColorsLastVerbKey !== verbColor
		|| _themeColorsLastStatusKey !== statusColor;
	if (settingsChanged) {
		_themeColorsLastAdaptive = adaptive;
		_themeColorsLastVerbKey = verbColor;
		_themeColorsLastStatusKey = statusColor;
		_themeColorsCacheTheme = null;
		if (!adaptive) {
			CLAUDE_ORANGE = _DEFAULT_CLAUDE_ORANGE;
			STATUS_DIM = _DEFAULT_STATUS_DIM;
		}
	}

	if (!theme || !adaptive) return;
	if (_themeColorsCacheTheme === theme) return;
	_themeColorsCacheTheme = theme;

	const verb = resolveThemeColor(theme, verbColor, "accent");
	if (verb) CLAUDE_ORANGE = verb;
	const status = resolveThemeColor(theme, statusColor, "muted");
	if (status) STATUS_DIM = status;
}

// Match OpenBrawd's spinner glyph set, with the final Ghostty frame restored
// to ✽ because the user's font-codepoint-map now centers it correctly.
function getDefaultSpinnerCharacters(): string[] {
	if (process.env.TERM === "xterm-ghostty") {
		return ["·", "✢", "✳", "✶", "✻", "✽"];
	}
	return process.platform === "darwin"
		? ["·", "✢", "✳", "✶", "✻", "✽"]
		: ["·", "✢", "*", "✶", "✻", "✽"];
}

const SPINNER_CHARS = getDefaultSpinnerCharacters();
const OB_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];
// Claude Code advances its live spinner glyph at 2 Hz (one frame every 500 ms),
// captured from a real session — CLFY-8. The inherited OpenBrawd cadence was
// 250 ms (4 Hz), which read twice as fast. The glyph set/bounce is unchanged;
// only the frame interval is corrected.
export const LOADER_INTERVAL_MS = 500;
const LOADER_LAST_TEXT = Symbol.for("pi-claudify:loader-last-text");
const LOADER_ACTIVE = Symbol.for("pi-claudify:loader-active");
const LOADER_GENERATION = Symbol.for("pi-claudify:loader-generation");
const ACTIVE_UI_SYMBOL = Symbol.for("pi-claudify:active-ui");

function getLoaderIntervalMs(_loader: any): number {
	return LOADER_INTERVAL_MS;
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | null | undefined): void {
	(timer as any)?.unref?.();
}

(Loader.prototype as any).updateDisplay = function patchedUpdateDisplay() {
	applyThemeColors(this.ui?.theme);
	const frame = OB_FRAMES[this.currentFrame % OB_FRAMES.length];
	const message = typeof this.message === "string" && RAW_ANSI_RE.test(this.message)
		? this.message
		: this.messageColorFn(this.message);
	const glyphColor = shimmerActive() ? shimmerGlyphAnsi(shimmerElapsedMs()) : CLAUDE_ORANGE;
	const nextText = `${glyphColor}${frame}${RESET} ${message}`;
	if ((this as any)[LOADER_LAST_TEXT] === nextText) return;
	(this as any)[LOADER_LAST_TEXT] = nextText;
	this.setText(nextText);
	if (this.ui && !(this.ui as any).stopped) {
		(globalThis as any)[ACTIVE_UI_SYMBOL] = this.ui;
		this.ui.requestRender();
	}
};

Loader.prototype.start = function patchedStart() {
	this.stop();
	(this as any)[LOADER_ACTIVE] = true;
	const generation = ((this as any)[LOADER_GENERATION] ?? 0) + 1;
	(this as any)[LOADER_GENERATION] = generation;
	delete (this as any)[LOADER_LAST_TEXT];
	(this as any).updateDisplay();
	const scheduleNext = () => {
		if ((this as any)[LOADER_ACTIVE] !== true || (this as any)[LOADER_GENERATION] !== generation) return;
		const intervalMs = getLoaderIntervalMs(this);
		const timer = setTimeout(() => {
			(this as any).intervalId = null;
			if ((this as any)[LOADER_ACTIVE] !== true || (this as any)[LOADER_GENERATION] !== generation) return;
			(this as any).currentFrame = ((this as any).currentFrame + 1) % OB_FRAMES.length;
			(this as any).updateDisplay();
			scheduleNext();
		}, intervalMs);
		unrefTimer(timer);
		(this as any).intervalId = timer;
	};
	scheduleNext();
};

Loader.prototype.stop = function patchedStop() {
	(this as any)[LOADER_ACTIVE] = false;
	(this as any)[LOADER_GENERATION] = ((this as any)[LOADER_GENERATION] ?? 0) + 1;
	if ((this as any).intervalId) {
		clearTimeout((this as any).intervalId);
		(this as any).intervalId = null;
	}
};

// ---------------------------------------------------------------------------
// Spinner verbs — fun/whimsical loading messages (different set from OpenBrawd)
// ---------------------------------------------------------------------------

export const DEFAULT_SPINNER_VERBS = [
	"Accomplishing",
	"Actioning",
	"Actualizing",
	"Architecting",
	"Baking",
	"Beaming",
	"Beboppin'",
	"Befuddling",
	"Billowing",
	"Blanching",
	"Bloviating",
	"Boogieing",
	"Boondoggling",
	"Booping",
	"Bootstrapping",
	"Brewing",
	"Bunning",
	"Burrowing",
	"Calculating",
	"Canoodling",
	"Caramelizing",
	"Cascading",
	"Catapulting",
	"Cerebrating",
	"Channeling",
	"Choreographing",
	"Churning",
	"Coalescing",
	"Cogitating",
	"Combobulating",
	"Composing",
	"Computing",
	"Concocting",
	"Considering",
	"Contemplating",
	"Cooking",
	"Crafting",
	"Creating",
	"Crunching",
	"Crystallizing",
	"Cultivating",
	"Deciphering",
	"Deliberating",
	"Determining",
	"Dilly-dallying",
	"Discombobulating",
	"Doodling",
	"Drizzling",
	"Ebbing",
	"Effecting",
	"Elucidating",
	"Embellishing",
	"Enchanting",
	"Envisioning",
	"Evaporating",
	"Fermenting",
	"Fiddle-faddling",
	"Finagling",
	"Flambéing",
	"Flibbertigibbeting",
	"Flowing",
	"Flummoxing",
	"Fluttering",
	"Forging",
	"Forming",
	"Frolicking",
	"Frosting",
	"Gallivanting",
	"Galloping",
	"Garnishing",
	"Generating",
	"Gesticulating",
	"Germinating",
	"Grooving",
	"Gusting",
	"Harmonizing",
	"Hashing",
	"Hatching",
	"Herding",
	"Hullaballooing",
	"Hyperspacing",
	"Ideating",
	"Imagining",
	"Improvising",
	"Incubating",
	"Inferring",
	"Infusing",
	"Ionizing",
	"Jitterbugging",
	"Julienning",
	"Kneading",
	"Leavening",
	"Levitating",
	"Lollygagging",
	"Manifesting",
	"Marinating",
	"Meandering",
	"Metamorphosing",
	"Misting",
	"Moonwalking",
	"Moseying",
	"Mulling",
	"Mustering",
	"Musing",
	"Nebulizing",
	"Nesting",
	"Noodling",
	"Nucleating",
	"Orbiting",
	"Orchestrating",
	"Osmosing",
	"Perambulating",
	"Percolating",
	"Perusing",
	"Philosophising",
	"Photosynthesizing",
	"Pollinating",
	"Pondering",
	"Pontificating",
	"Pouncing",
	"Precipitating",
	"Prestidigitating",
	"Processing",
	"Proofing",
	"Propagating",
	"Puttering",
	"Puzzling",
	"Quantumizing",
	"Razzle-dazzling",
	"Razzmatazzing",
	"Recombobulating",
	"Reticulating",
	"Roosting",
	"Ruminating",
	"Sautéing",
	"Scampering",
	"Schlepping",
	"Scurrying",
	"Seasoning",
	"Shenaniganing",
	"Shimmying",
	"Simmering",
	"Skedaddling",
	"Sketching",
	"Slithering",
	"Smooshing",
	"Sock-hopping",
	"Spelunking",
	"Spinning",
	"Sprouting",
	"Stewing",
	"Sublimating",
	"Swirling",
	"Swooping",
	"Symbioting",
	"Synthesizing",
	"Tempering",
	"Thinking",
	"Thundering",
	"Tinkering",
	"Tomfoolering",
	"Topsy-turvying",
	"Transfiguring",
	"Transmuting",
	"Twisting",
	"Undulating",
	"Unfurling",
	"Unravelling",
	"Vibing",
	"Waddling",
	"Wandering",
	"Warping",
	"Whatchamacalliting",
	"Whirlpooling",
	"Whirring",
	"Whisking",
	"Wibbling",
	"Working",
	"Wrangling",
	"Zesting",
	"Zigzagging",
];

// ---------------------------------------------------------------------------
// Spinner glyph characters are now patched into the Loader above.
// No separate glyph prefix needed.
// ---------------------------------------------------------------------------

function pickVerb(): string {
	const verbs = readSpinnerSettings().verbs;
	return verbs[Math.floor(Math.random() * verbs.length)] ?? DEFAULT_SPINNER_VERBS[0];
}

/** Format elapsed ms as compact duration: 5s, 1m 23s, 1h 2m 3s */
function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function estimateResponseLength(message: any): number {
	if (!Array.isArray(message?.content)) return 0;
	return message.content.reduce((sum: number, block: any) =>
		sum + (block?.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0);
}

function textBlockLengths(message: any): number[] {
	if (!Array.isArray(message?.content)) return [];
	const lengths: number[] = [];
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block?.type === "text" && typeof block.text === "string") {
			lengths[i] = block.text.length;
		}
	}
	return lengths;
}

function statusText(text: string): string {
	return `${STATUS_DIM}${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Threshold before showing elapsed time in status parentheses */
const SHOW_TIMER_AFTER_MS = 30_000;

/** How long to preserve "thought for Ns" across turns */
const THOUGHT_DISPLAY_MS = 3_500;

/** Minimum thinking duration before showing "thought for Ns" */
const MIN_THINKING_SHOW_MS = 100;

/** Message refresh cadence. Keep constant so status updates don't stall on long sessions. */
const WORKING_MESSAGE_INTERVAL_MS = 1_000;

/** Completion message linger */
const TURN_COMPLETION_MS = 2_500;


export default function (pi: ExtensionAPI) {
	let agentStartTime = 0;
	let turnStartTime = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let completionTimer: ReturnType<typeof setTimeout> | null = null;
	let thoughtStatusTimer: ReturnType<typeof setTimeout> | null = null;
	let currentVerb = "";
	let responseLength = 0;
	let responseTextBlockLengths: number[] = [];
	let thinkingStatus: "thinking" | number /* duration ms */ | null = null;
	let thinkingStartTime = 0;
	let thoughtForSetAt = 0;
	let activeTurnId = 0;
	let turnActive = false;
	let lastWorkingMessage: string | null = null;
	let activeCtx: { ui: any; hasUI: boolean } | null = null;

	function getEffortSuffix(): string {
		try {
			const level = pi.getThinkingLevel();
			if (!level || level === "off") return "";
			return ` with ${level} effort`;
		} catch {
			return "";
		}
	}

	function buildWorkingMessage(): string {
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		const tokenCount = Math.max(0, Math.round(responseLength / 4));
		const statusParts: string[] = [];

		// Claude Code orders the status list duration → tokens → thinking, e.g.
		// "✽ Gathering the Fellowship… (3s · ↓ 162 tokens · thought for 1s)".
		if (elapsed > SHOW_TIMER_AFTER_MS || thinkingStatus !== null || tokenCount > 0) {
			statusParts.push(formatDuration(elapsed));
		}

		if (tokenCount > 0) {
			statusParts.push(`↓ ${formatCount(tokenCount)} tokens`);
		}

		if (thinkingStatus === "thinking") {
			statusParts.push(`thinking${getEffortSuffix()}`);
		} else if (typeof thinkingStatus === "number") {
			statusParts.push(`thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`);
		}

		let message = shimmerActive()
			? colorizeShimmerVerb(`${currentVerb}…`, elapsed)
			: `${CLAUDE_ORANGE}${currentVerb}…${RESET}`;
		if (statusParts.length > 0) {
			message += statusText(` (${statusParts.join(" · ")})`);
		}
		return message;
	}

	function setResponseTextBlockLength(index: number, length: number): void {
		const previous = responseTextBlockLengths[index] ?? 0;
		responseTextBlockLengths[index] = Math.max(0, length);
		responseLength = Math.max(0, responseLength + responseTextBlockLengths[index] - previous);
	}

	function resetResponseTracking(message?: any): void {
		responseTextBlockLengths = message ? textBlockLengths(message) : [];
		responseLength = message ? estimateResponseLength(message) : 0;
	}

	function syncWorkingMessage(force = false): void {
		// Anchor the shimmer to the same elapsed base buildWorkingMessage uses, so the
		// glyph (read from _shimmerAnchorMs in updateDisplay) tracks the verb's escalation.
		_shimmerAnchorMs = turnActive ? (agentStartTime || turnStartTime) : 0;
		if (!activeCtx?.hasUI) return;
		// Re-derive colors on every tick so Claudify screen color/status changes
		// take effect within ~250 ms without waiting for the next pi event.
		// applyThemeColors is identity-cached on (theme, spinnerKey, statusKey) so
		// this is cheap when nothing changed.
		applyThemeColors(activeCtx.ui?.theme);
		const nextMessage = buildWorkingMessage();
		if (!force && nextMessage === lastWorkingMessage) return;
		lastWorkingMessage = nextMessage;
		try {
			activeCtx.ui.setWorkingMessage(nextMessage);
		} catch { /* noop */ }
	}

	function restoreDefaultWorkingMessage(): void {
		lastWorkingMessage = null;
		if (!activeCtx?.hasUI) return;
		try {
			activeCtx.ui.setWorkingMessage();
		} catch { /* noop */ }
	}

	function getWorkingMessageIntervalMs(): number {
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		// The shimmer animates continuously (sweep ⇄ breathe), so refresh at the
		// animation cadence for as long as it's active.
		if (_shimmerEnabled && _shimmerAnchorMs > 0) {
			return SHIMMER_REFRESH_MS;
		}
		const tokenCount = Math.max(0, Math.round(responseLength / 4));
		// Keep ticking once per second even when idle so Claudify screen changes
		// take effect within ~1s and elapsed-time crossover into the timer-on
		// state still fires close to 30s. syncWorkingMessage short-circuits
		// when the rendered string is unchanged, so the cost is negligible.
		if (thinkingStatus === null && tokenCount === 0 && elapsed <= SHOW_TIMER_AFTER_MS) {
			return Math.max(250, Math.min(WORKING_MESSAGE_INTERVAL_MS, SHOW_TIMER_AFTER_MS - elapsed + 1));
		}
		return Math.max(250, WORKING_MESSAGE_INTERVAL_MS - (elapsed % WORKING_MESSAGE_INTERVAL_MS));
	}

	function scheduleRefreshTick(): void {
		if (!turnActive || refreshTimer) return;
		const intervalMs = getWorkingMessageIntervalMs();
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			syncWorkingMessage();
			scheduleRefreshTick();
		}, intervalMs);
		unrefTimer(refreshTimer);
	}

	function startRefreshLoop(): void {
		stopRefreshLoop();
		syncWorkingMessage(true);
		scheduleRefreshTick();
	}

	function rescheduleRefreshLoop(): void {
		if (!turnActive) return;
		stopRefreshLoop();
		scheduleRefreshTick();
	}

	function stopRefreshLoop(): void {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}

	function clearCompletionTimer(): void {
		if (completionTimer) {
			clearTimeout(completionTimer);
			completionTimer = null;
		}
	}

	function clearThoughtStatusTimer(): void {
		if (thoughtStatusTimer) {
			clearTimeout(thoughtStatusTimer);
			thoughtStatusTimer = null;
		}
	}

	function scheduleThoughtStatusClear(): void {
		clearThoughtStatusTimer();
		if (typeof thinkingStatus !== "number") return;
		const remaining = THOUGHT_DISPLAY_MS - (Date.now() - thoughtForSetAt);
		if (remaining <= 0) {
			thinkingStatus = null;
			if (turnActive) syncWorkingMessage(true);
			else if (!completionTimer) restoreDefaultWorkingMessage();
			return;
		}
		thoughtStatusTimer = setTimeout(() => {
			thoughtStatusTimer = null;
			if (typeof thinkingStatus !== "number") return;
			if (Date.now() - thoughtForSetAt < THOUGHT_DISPLAY_MS) {
				scheduleThoughtStatusClear();
				return;
			}
			thinkingStatus = null;
			if (turnActive) syncWorkingMessage(true);
			else if (!completionTimer) restoreDefaultWorkingMessage();
		}, remaining);
		unrefTimer(thoughtStatusTimer);
	}

	function clearDisplay(): void {
		stopRefreshLoop();
		clearCompletionTimer();
		clearThoughtStatusTimer();
		_shimmerAnchorMs = 0;
		agentStartTime = 0;
		turnStartTime = 0;
		thinkingStatus = null;
		thoughtForSetAt = 0;
		resetResponseTracking();
		restoreDefaultWorkingMessage();
	}

	function onThinkingEnd(): void {
		if (thinkingStatus !== "thinking") return;
		const duration = Date.now() - thinkingStartTime;
		if (duration < MIN_THINKING_SHOW_MS) {
			thinkingStatus = null;
			clearThoughtStatusTimer();
			return;
		}
		thinkingStatus = duration;
		thoughtForSetAt = Date.now();
		scheduleThoughtStatusClear();
	}

	pi.on("before_agent_start", async () => {
		// Start once per top-level request. Steering/follow-up messages while the
		// agent is active must not reset the timer.
		if (!agentStartTime) agentStartTime = Date.now();
	});

	pi.on("agent_start", async () => {
		if (!agentStartTime) agentStartTime = Date.now();
	});

	pi.on("turn_start", async (_event, ctx) => {
		activeTurnId++;
		turnActive = true;
		activeCtx = ctx;
		applyThemeColors(ctx.ui?.theme);
		turnStartTime = Date.now();
		if (!agentStartTime) agentStartTime = turnStartTime;
		currentVerb = pickVerb();
		resetResponseTracking();
		clearCompletionTimer();
		if (typeof thinkingStatus !== "number" || Date.now() - thoughtForSetAt >= THOUGHT_DISPLAY_MS) {
			thinkingStatus = null;
			clearThoughtStatusTimer();
		} else {
			scheduleThoughtStatusClear();
		}
		startRefreshLoop();
	});

	pi.on("message_update", async (event, ctx) => {
		activeCtx = ctx;
		applyThemeColors(ctx.ui?.theme);
		const evt = event.assistantMessageEvent;
		let statusChanged = false;
		const previousTokenCount = Math.max(0, Math.round(responseLength / 4));

		if (evt.type === "start") {
			resetResponseTracking();
		} else if (evt.type === "text_start") {
			setResponseTextBlockLength(evt.contentIndex, 0);
		} else if (evt.type === "text_delta") {
			const previous = responseTextBlockLengths[evt.contentIndex] ?? 0;
			setResponseTextBlockLength(evt.contentIndex, previous + (typeof evt.delta === "string" ? evt.delta.length : 0));
		} else if (evt.type === "text_end") {
			setResponseTextBlockLength(evt.contentIndex, typeof evt.content === "string" ? evt.content.length : 0);
		} else if (evt.type === "done") {
			resetResponseTracking(evt.message);
		} else if (evt.type === "error") {
			resetResponseTracking(evt.error);
		}

		if (evt.type === "thinking_start") {
			clearThoughtStatusTimer();
			thinkingStatus = "thinking";
			thinkingStartTime = Date.now();
			statusChanged = true;
		}
		if (evt.type === "thinking_end") {
			onThinkingEnd();
			statusChanged = true;
		}

		if (statusChanged) {
			syncWorkingMessage(true);
			rescheduleRefreshLoop();
			return;
		}

		const nextTokenCount = Math.max(0, Math.round(responseLength / 4));
		if (previousTokenCount === 0 && nextTokenCount > 0) {
			rescheduleRefreshLoop();
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		turnActive = false;
		_shimmerAnchorMs = 0; // the "✻ Worked for …" completion line is not shimmered
		activeCtx = ctx;
		applyThemeColors(ctx.ui?.theme);
		const turnId = activeTurnId;
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		stopRefreshLoop();
		clearCompletionTimer();

		if (typeof thinkingStatus === "number" && Date.now() - thoughtForSetAt >= THOUGHT_DISPLAY_MS) {
			thinkingStatus = null;
			clearThoughtStatusTimer();
		}

		if (activeCtx?.hasUI) {
			const message = `${STATUS_DIM}✻ Worked for ${formatDuration(elapsed)}${RESET}`;
			lastWorkingMessage = message;
			try {
				activeCtx.ui.setWorkingMessage(message);
			} catch { /* noop */ }
			completionTimer = setTimeout(() => {
				completionTimer = null;
				if (activeTurnId !== turnId) return;
				restoreDefaultWorkingMessage();
			}, TURN_COMPLETION_MS);
			unrefTimer(completionTimer);
		} else if (typeof thinkingStatus !== "number") {
			restoreDefaultWorkingMessage();
		}

		responseLength = 0;
		responseTextBlockLengths = [];
	});

	pi.on("agent_end", async () => {
		turnActive = false;
		agentStartTime = 0;
		// Preserve the just-finished "Worked for …" line. Pi emits agent_end
		// immediately after the final turn, so clearing here made the completion
		// status disappear before users could see it.
		if (completionTimer) return;
		clearDisplay();
	});

	pi.on("session_shutdown", async () => {
		turnActive = false;
		clearDisplay();
		activeCtx = null;
	});
}
