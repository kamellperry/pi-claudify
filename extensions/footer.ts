import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

import { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { readSettings, type SettingsFile } from "./settings.ts";

// Claude Code-style statusline footer + pinned-gray input border.
// Capture and decisions: docs/plans/2026-07-16-cc-input-box-footer.md.

export type FooterStyle = "claude" | "pi";
export type FooterColorMode = "colored" | "single" | "monochrome";
export type EditorBorderMode = "gray" | "thinking";
export type UsageWindowLabel = "Usage" | "Week";

export interface FooterSettings {
	readonly style: FooterStyle;
	readonly colorMode: FooterColorMode;
	readonly color: string;
	readonly usageBar: boolean;
	readonly effort: boolean;
	readonly editorBorder: EditorBorderMode;
}

export interface UsageWindowData {
	readonly label: UsageWindowLabel;
	readonly percent: number | null;
	/** Epoch milliseconds; null when the provider omits its reset timestamp. */
	readonly resetsAt: number | null;
}

export const DEFAULT_FOOTER_COLOR = "#FF9200";

const RESET = "\x1b[0m";
const BLUE = "\x1b[0;34m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[0;33m";
const CYAN = "\x1b[0;36m";
const GRAY = "\x1b[0;90m";
const CONTEXT_HOT = "\x1b[38;5;160m";
const USAGE_LEVELS = [
	"\x1b[38;5;22m",
	"\x1b[38;5;28m",
	"\x1b[38;5;34m",
	"\x1b[38;5;100m",
	"\x1b[38;5;142m",
	"\x1b[38;5;178m",
	"\x1b[38;5;172m",
	"\x1b[38;5;166m",
	CONTEXT_HOT,
	"\x1b[38;5;124m",
] as const;
// Claude Code's input-box gray under a 256-color terminal; used only when the
// active theme has no borderMuted key to fall back on.
const FALLBACK_BORDER_GRAY = "\x1b[38;5;244m";

const BAR_BLOCKS = 10;
const USAGE_CACHE_TTL_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const ANTHROPIC_PLACEHOLDERS: readonly UsageWindowData[] = [
	{ label: "Usage", percent: null, resetsAt: null },
	{ label: "Week", percent: null, resetsAt: null },
];
const OPENAI_PLACEHOLDERS: readonly UsageWindowData[] = [
	{ label: "Week", percent: null, resetsAt: null },
];

/** Accepts "#RRGGBB" or "RRGGBB" (any case); returns canonical "#RRGGBB" or null. */
export function normalizeHexColor(raw: string): string | null {
	const match = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim());
	return match ? `#${match[1].toUpperCase()}` : null;
}

function hexToAnsi(hex: string): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

export function resolveFooterSettings(values: SettingsFile): FooterSettings {
	const style = values.footerStyle === "pi" ? "pi" : "claude";
	const colorMode = values.footerColorMode === "single" || values.footerColorMode === "monochrome"
		? values.footerColorMode
		: "colored";
	const color = typeof values.footerColor === "string"
		? normalizeHexColor(values.footerColor) ?? DEFAULT_FOOTER_COLOR
		: DEFAULT_FOOTER_COLOR;
	return {
		style,
		colorMode,
		color,
		usageBar: values.footerUsageBar !== false,
		effort: values.footerEffort !== false,
		editorBorder: values.editorBorder === "thinking" ? "thinking" : "gray",
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function percentageValue(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
	return Math.round(value);
}

function parseResetTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.round(value < 1_000_000_000_000 ? value * 1_000 : value);
	}
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parsedWindow(
	label: UsageWindowLabel,
	value: unknown,
	percentKey: "utilization" | "used_percent",
	resetKey: "resets_at" | "reset_at",
): UsageWindowData | null {
	const record = recordValue(value);
	if (!record) return null;
	const percent = percentageValue(record[percentKey]);
	if (percent === null) return null;
	return { label, percent, resetsAt: parseResetTimestamp(record[resetKey]) };
}

export function parseAnthropicUsage(payload: unknown): readonly UsageWindowData[] {
	const root = recordValue(payload);
	if (!root) return [];
	return [
		parsedWindow("Usage", root.five_hour, "utilization", "resets_at"),
		parsedWindow("Week", root.seven_day, "utilization", "resets_at"),
	].filter((window): window is UsageWindowData => window !== null);
}

// The 7-day window (604800s). Anything at least ~6 days counts as weekly; this
// rejects the 5-hour primary window while tolerating minor span drift.
const OPENAI_WEEKLY_MIN_SECONDS = 6 * 24 * 60 * 60;

function windowSpanSeconds(window: Record<string, unknown>): number {
	const span = window.limit_window_seconds;
	return typeof span === "number" && Number.isFinite(span) ? span : 0;
}

/**
 * Codex reports two rate-limit windows and which one is the 7-day "Week" varies
 * by plan. The common shape puts the weekly window in `secondary_window` (with a
 * 5-hour `primary_window`); but on some plans — observed live for `plan_type`
 * "prolite", capture docs/plans/2026-07-17-cc-quota-payloads.md — `secondary_window`
 * is null and the 7-day window IS `primary_window`. Reading `secondary_window`
 * unconditionally rendered a permanent "~" for every such user (CLFY-25). Pick,
 * of the two windows, the longest one that spans a weekly scale; when neither
 * reports a span at all, fall back to the legacy secondary→primary order.
 */
function openAIWeeklyWindow(rateLimit: Record<string, unknown> | null): unknown {
	if (!rateLimit) return null;
	const secondary = recordValue(rateLimit.secondary_window);
	const primary = recordValue(rateLimit.primary_window);
	const windows = [secondary, primary].filter((w): w is Record<string, unknown> => w !== null);
	const weekly = windows
		.filter((w) => windowSpanSeconds(w) >= OPENAI_WEEKLY_MIN_SECONDS)
		.sort((a, b) => windowSpanSeconds(b) - windowSpanSeconds(a))[0];
	if (weekly) return weekly;
	// A span was reported but none is weekly (e.g. a 5-hour-only window): do not
	// mislabel it "Week". Only when no window reports a span do we fall back.
	if (windows.some((w) => windowSpanSeconds(w) > 0)) return null;
	return secondary ?? primary ?? null;
}

export function parseOpenAIUsage(payload: unknown): readonly UsageWindowData[] {
	const root = recordValue(payload);
	const rateLimit = recordValue(root?.rate_limit);
	const week = parsedWindow("Week", openAIWeeklyWindow(rateLimit), "used_percent", "reset_at");
	return week ? [week] : [];
}

interface UsageModelLike {
	readonly provider?: string;
	readonly id?: string;
}

interface UsageModelRegistryLike {
	isUsingOAuth(model: UsageModelLike): boolean;
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

type UsageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type UsageProviderId = "anthropic" | "openai-codex";

interface UsageTarget {
	readonly provider: UsageProviderId;
	readonly url: string;
	readonly placeholders: readonly UsageWindowData[];
	readonly parse: (payload: unknown) => readonly UsageWindowData[];
}

interface UsageCacheEntry {
	readonly expiresAt: number;
	readonly windows: readonly UsageWindowData[];
}

export interface ProviderUsageSourceOptions {
	readonly getModel: () => UsageModelLike | undefined;
	readonly modelRegistry: UsageModelRegistryLike;
	readonly fetcher: UsageFetch;
	readonly onUpdate: () => void;
	readonly now?: () => number;
}

function usageTarget(provider: string): UsageTarget | null {
	if (provider === "anthropic") {
		return {
			provider,
			url: ANTHROPIC_USAGE_URL,
			placeholders: ANTHROPIC_PLACEHOLDERS,
			parse: parseAnthropicUsage,
		};
	}
	if (provider === "openai-codex") {
		return {
			provider,
			url: OPENAI_USAGE_URL,
			placeholders: OPENAI_PLACEHOLDERS,
			parse: parseOpenAIUsage,
		};
	}
	return null;
}

function openAIAccountId(token: string): string | null {
	try {
		const payloadPart = token.split(".")[1];
		if (!payloadPart) return null;
		const payload = recordValue(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")));
		const auth = recordValue(payload?.["https://api.openai.com/auth"]);
		const accountId = auth?.chatgpt_account_id ?? payload?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : null;
	} catch {
		return null;
	}
}

function usageHeaders(provider: UsageProviderId, token: string): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		authorization: `Bearer ${token}`,
	};
	if (provider === "anthropic") {
		headers["anthropic-beta"] = "oauth-2025-04-20";
		headers["user-agent"] = "claude-code/2.1.211 (pi-claudify/2.1.0)";
		return headers;
	}
	const accountId = openAIAccountId(token);
	if (accountId) headers["chatgpt-account-id"] = accountId;
	return headers;
}

/**
 * Lazily resolves pi-managed OAuth and caches only validated quota values.
 * Tokens live only in the request-local stack and are never persisted or logged.
 */
export class ProviderUsageSource {
	private readonly options: ProviderUsageSourceOptions;
	private readonly cache = new Map<UsageProviderId, UsageCacheEntry>();
	private readonly inFlight = new Map<UsageProviderId, Promise<void>>();
	private readonly controllers = new Map<UsageProviderId, AbortController>();
	private activeProvider: UsageProviderId | null = null;
	private disposed = false;

	constructor(options: ProviderUsageSourceOptions) {
		this.options = options;
	}

	getUsage(): readonly UsageWindowData[] {
		const target = this.selectTarget();
		if (!target) return [];
		const cached = this.cache.get(target.provider);
		if (!cached || cached.expiresAt <= this.now()) void this.refreshTarget(target);
		return cached?.windows ?? target.placeholders;
	}

	refresh(): Promise<void> {
		const target = this.selectTarget();
		return target ? this.refreshTarget(target) : Promise.resolve();
	}

	dispose(): void {
		this.disposed = true;
		this.activeProvider = null;
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
		this.inFlight.clear();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private currentTarget(): UsageTarget | null {
		if (this.disposed) return null;
		const model = this.options.getModel();
		if (!model || typeof model.provider !== "string") return null;
		const target = usageTarget(model.provider);
		if (!target) return null;
		try {
			return this.options.modelRegistry.isUsingOAuth(model) ? target : null;
		} catch {
			return null;
		}
	}

	private selectTarget(): UsageTarget | null {
		const target = this.currentTarget();
		const nextProvider = target?.provider ?? null;
		if (nextProvider === this.activeProvider) return target;
		this.activeProvider = nextProvider;
		for (const provider of [...this.controllers.keys()]) {
			if (provider !== nextProvider) this.cancelProvider(provider);
		}
		return target;
	}

	private cancelProvider(provider: UsageProviderId): void {
		this.controllers.get(provider)?.abort();
		this.controllers.delete(provider);
		this.inFlight.delete(provider);
	}

	private isCurrent(target: UsageTarget): boolean {
		return !this.disposed && this.currentTarget()?.provider === target.provider;
	}

	private refreshTarget(target: UsageTarget): Promise<void> {
		if (!this.isCurrent(target)) return Promise.resolve();
		const cached = this.cache.get(target.provider);
		if (cached && cached.expiresAt > this.now()) return Promise.resolve();
		const active = this.inFlight.get(target.provider);
		if (active) return active;
		const controller = new AbortController();
		this.controllers.set(target.provider, controller);
		const request = this.fetchTarget(target, controller).finally(() => {
			if (this.inFlight.get(target.provider) === request) this.inFlight.delete(target.provider);
			if (this.controllers.get(target.provider) === controller) this.controllers.delete(target.provider);
		});
		this.inFlight.set(target.provider, request);
		return request;
	}

	private async fetchTarget(target: UsageTarget, lifecycleController: AbortController): Promise<void> {
		let windows = target.placeholders;
		const requestController = new AbortController();
		const abortRequest = (): void => requestController.abort();
		lifecycleController.signal.addEventListener("abort", abortRequest, { once: true });
		const timeout = setTimeout(abortRequest, USAGE_REQUEST_TIMEOUT_MS);
		try {
			const token = await this.options.modelRegistry.getApiKeyForProvider(target.provider);
			if (token && !requestController.signal.aborted && this.isCurrent(target)) {
				const response = await this.options.fetcher(target.url, {
					method: "GET",
					headers: usageHeaders(target.provider, token),
					signal: requestController.signal,
				});
				if (response.ok) {
					const parsed = target.parse(await response.json());
					windows = target.placeholders.map((placeholder) =>
						parsed.find((window) => window.label === placeholder.label) ?? placeholder);
				}
			}
		} catch {
			// Provider quota endpoints are undocumented; placeholders are the safe fallback.
		} finally {
			clearTimeout(timeout);
			lifecycleController.signal.removeEventListener("abort", abortRequest);
		}
		if (!this.isCurrent(target) || lifecycleController.signal.aborted) return;
		this.cache.set(target.provider, { windows, expiresAt: this.now() + USAGE_CACHE_TTL_MS });
		this.options.onUpdate();
	}
}

export interface FooterLineData {
	readonly directory: string;
	/** null outside a git repo — the segment is omitted, like the script. */
	readonly branch: string | null;
	readonly modelName: string | null;
	/** pi's thinking level, or null when thinking is off or the model has none. */
	readonly effort: string | null;
	/** Percent of the current model's context window; null while tokens are unknown. */
	readonly contextPercent: number | null;
	readonly usage: readonly UsageWindowData[];
}

interface SegmentPalette {
	readonly dir: string;
	readonly branch: string;
	readonly model: string;
	readonly contextCool: string;
	readonly contextWarm: string;
	readonly contextHot: string;
	readonly usageUnknown: string;
	readonly usageLevels: readonly string[];
	readonly separator: string;
	readonly reset: string;
}

function paletteFor(settings: FooterSettings): SegmentPalette {
	if (settings.colorMode === "monochrome") {
		return {
			dir: "",
			branch: "",
			model: "",
			contextCool: "",
			contextWarm: "",
			contextHot: "",
			usageUnknown: "",
			usageLevels: USAGE_LEVELS.map(() => ""),
			separator: "",
			reset: "",
		};
	}
	if (settings.colorMode === "single") {
		const single = hexToAnsi(settings.color);
		return {
			dir: single,
			branch: single,
			model: single,
			contextCool: single,
			contextWarm: single,
			contextHot: single,
			usageUnknown: single,
			usageLevels: USAGE_LEVELS.map(() => single),
			separator: single,
			reset: RESET,
		};
	}
	return {
		dir: BLUE,
		branch: GREEN,
		model: YELLOW,
		contextCool: CYAN,
		contextWarm: YELLOW,
		contextHot: CONTEXT_HOT,
		usageUnknown: YELLOW,
		usageLevels: USAGE_LEVELS,
		separator: GRAY,
		reset: RESET,
	};
}

function quotaBar(percent: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = clamped === 0 ? 0 : clamped === 100 ? BAR_BLOCKS : Math.floor((clamped * BAR_BLOCKS + 50) / 100);
	return ` ${"▓".repeat(filled)}${"░".repeat(BAR_BLOCKS - filled)}`;
}

function usageColor(palette: SegmentPalette, percent: number | null): string {
	if (percent === null) return palette.usageUnknown;
	const tier = Math.max(0, Math.min(9, Math.ceil(percent / 10) - 1));
	return palette.usageLevels[tier] ?? palette.usageUnknown;
}

function resetTime(resetsAt: number | null): string | null {
	if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
	try {
		const rounded = Math.round(resetsAt / 60_000) * 60_000;
		return new Intl.DateTimeFormat("en-US", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
		}).format(new Date(rounded));
	} catch {
		return null;
	}
}

export function buildFooterLine(data: FooterLineData, settings: FooterSettings): string {
	const palette = paletteFor(settings);
	const paint = (color: string, text: string): string => (color ? `${color}${text}${palette.reset}` : text);
	const segments: string[] = [];

	if (data.directory) segments.push(paint(palette.dir, data.directory));
	if (data.branch) segments.push(paint(palette.branch, `⎇ ${data.branch}`));
	if (data.modelName) {
		// Claude Code spells this out ("Fable 5 with high effort") in its banner, never in
		// the statusline; the compact suffix keeps the segment short on narrow terminals.
		const effort = settings.effort && data.effort ? ` · ${data.effort}` : "";
		segments.push(paint(palette.model, `${data.modelName}${effort}`));
	}

	const contextPercent = data.contextPercent === null ? null : Math.floor(Math.max(0, Math.min(100, data.contextPercent)));
	const contextColor = contextPercent !== null && contextPercent > 75
		? palette.contextHot
		: contextPercent !== null && contextPercent > 50
			? palette.contextWarm
			: palette.contextCool;
	segments.push(paint(contextColor, `Ctx: ${contextPercent === null ? "?" : `${contextPercent}%`}`));

	for (const window of data.usage) {
		const percent = window.percent === null ? null : Math.round(Math.max(0, Math.min(100, window.percent)));
		let text = `${window.label}: ${percent === null ? "~" : `${percent}%`}`;
		if (percent !== null && settings.usageBar) text += quotaBar(percent);
		const reset = percent === null ? null : resetTime(window.resetsAt);
		if (reset) text += ` → Reset: ${reset}`;
		segments.push(paint(usageColor(palette, percent), text));
	}

	const separator = paint(palette.separator, " │ ");
	// Claude Code renders the statusline indented two columns below the input box.
	return `  ${segments.join(separator)}`;
}

/**
 * Deliberate divergence from the captured statusline, which prints
 * `basename $PWD`: inside a git worktree the folder is named after the branch,
 * so the first segment repeated the ⎇ segment verbatim. The main repository's
 * name is stable across worktrees and keeps the segment informative.
 */
export function projectNameFrom(cwd: string, gitCommonDir: string | null): string {
	const trimmedCwd = cwd.replace(/\/+$/, "");
	const fallback = basename(trimmedCwd) || cwd;
	if (!gitCommonDir) return fallback;
	const commonDir = gitCommonDir.replace(/\/+$/, "");
	const leaf = basename(commonDir);
	const name = leaf === ".git" ? basename(dirname(commonDir)) : leaf.replace(/\.git$/, "");
	return name || fallback;
}

// render() runs every frame, so the git probe happens once per directory.
const projectNames = new Map<string, string>();

function projectName(cwd: string): string {
	const cached = projectNames.get(cwd);
	if (cached !== undefined) return cached;
	let commonDir: string | null = null;
	try {
		commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim() || null;
	} catch {
		// Not a repository, or git is unavailable — the cwd basename still reads fine.
	}
	const name = projectNameFrom(cwd, commonDir);
	projectNames.set(cwd, name);
	return name;
}

/** The slice of pi's FooterDataProvider the footer reads; structural so tests can fake it. */
export interface FooterDataLike {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

/** Live session probes, each already guarded by the caller against a torn-down session. */
export interface FooterSources {
	getDirectory(): string;
	getBranch(footerData: FooterDataLike): string | null;
	getModelName(): string | null;
	getEffort(): string | null;
	getContextPercent(): number | null;
	getUsage(): readonly UsageWindowData[];
	dispose?(): void;
}

function sanitizeStatusText(text: string): string {
	// Also strip embedded SGR: extensions bake theme colors into status strings
	// at startup (e.g. the MCP adapter's teal), which would override the dim
	// wrapper below and survive any later theme change. Statuses render
	// uniformly dim, Claude-style.
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export class ClaudeFooterComponent {
	private readonly footerData: FooterDataLike;
	private readonly sources: FooterSources;

	constructor(footerData: FooterDataLike, sources: FooterSources) {
		this.footerData = footerData;
		this.sources = sources;
	}

	// pi-tui's Component contract declares invalidate() as required even though
	// every runtime call site optional-chains it; the no-op keeps the contract.
	invalidate(): void {}

	dispose(): void {
		this.sources.dispose?.();
	}

	render(width: number): string[] {
		const settings = resolveFooterSettings(readSettings().values);
		const line = buildFooterLine(
			{
				directory: this.sources.getDirectory(),
				branch: this.sources.getBranch(this.footerData),
				modelName: this.sources.getModelName(),
				effort: this.sources.getEffort(),
				contextPercent: this.sources.getContextPercent(),
				usage: this.sources.getUsage(),
			},
			settings,
		);
		const lines = [truncateToWidth(line, width, "…")];
		// pi's stock footer surfaces other extensions' ctx.ui.setStatus lines;
		// replacing the footer must not eat them.
		const statuses = [...this.footerData.getExtensionStatuses().entries()]
			.sort(([a], [b]) => a.localeCompare(b));
		const dim = settings.colorMode === "monochrome" ? "" : GRAY;
		for (const [, text] of statuses) {
			const status = sanitizeStatusText(text);
			if (!status) continue;
			lines.push(truncateToWidth(dim ? `  ${dim}${status}${RESET}` : `  ${status}`, width, "…"));
		}
		return lines;
	}
}

/**
 * Install (or uninstall) the Claude-style footer for the current session. `pi` is
 * the extension API; only the thinking level is read from it, so omitting it just
 * drops the effort suffix.
 */
export function installClaudeFooter(ctx: any, pi?: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setFooter !== "function") return;
	if (resolveFooterSettings(readSettings().values).style !== "claude") {
		ctx.ui.setFooter(undefined);
		return;
	}
	ctx.ui.setFooter((tui: any, _theme: unknown, footerData: FooterDataLike) => {
		const registry = ctx.modelRegistry;
		const usageSource = registry
			&& typeof registry.isUsingOAuth === "function"
			&& typeof registry.getApiKeyForProvider === "function"
			&& typeof globalThis.fetch === "function"
			? new ProviderUsageSource({
				getModel: () => ctx.model,
				modelRegistry: registry,
				fetcher: globalThis.fetch.bind(globalThis),
				onUpdate: () => {
					try {
						tui.requestRender();
					} catch {
						// The session may have been replaced while the request was in flight.
					}
				},
			})
			: null;
		const sources: FooterSources = {
			getDirectory() {
				try {
					const cwd: unknown = ctx.sessionManager?.getCwd?.();
					return projectName(typeof cwd === "string" && cwd ? cwd : process.cwd());
				} catch {
					return "";
				}
			},
			getBranch(data) {
				try {
					return data.getGitBranch();
				} catch {
					return null;
				}
			},
			getModelName() {
				try {
					return ctx.model?.name || ctx.model?.id || null;
				} catch {
					return null;
				}
			},
			getEffort() {
				try {
					// The thinking level hangs off pi's ExtensionAPI, not the per-event
					// ExtensionContext the rest of these sources read.
					const level: unknown = pi?.getThinkingLevel?.();
					return typeof level === "string" && level && level !== "off" ? level : null;
				} catch {
					return null;
				}
			},
			getContextPercent() {
				try {
					const percent: unknown = ctx.getContextUsage?.()?.percent;
					return typeof percent === "number" && Number.isFinite(percent) ? percent : null;
				} catch {
					return null;
				}
			},
			getUsage() {
				return usageSource?.getUsage() ?? [];
			},
			dispose() {
				usageSource?.dispose();
			},
		};
		return new ClaudeFooterComponent(footerData, sources);
	});
}

const BORDER_PATCH_FLAG = Symbol.for("claudify.editorBorderPatch");

/**
 * Pin pi's input-box border to gray, the way Claude Code keeps it in every
 * permission mode and at every effort level. pi reassigns
 * editor.borderColor = theme.getThinkingBorderColor(level) on every thinking/
 * model/theme event, so patching the editor instance would not hold; wrapping
 * the Theme method does, and the returned colorizer re-checks the setting each
 * time it runs (every render), so toggling the setting reflects live without
 * waiting for a thinking-level event. Bash mode (getBashModeBorderColor) is
 * left untouched — Claude Code recolors that state too.
 */
export function patchEditorBorderColor(): void {
	const proto = Theme.prototype as any;
	if (proto[BORDER_PATCH_FLAG]) return;
	const original = proto.getThinkingBorderColor;
	if (typeof original !== "function") return;
	proto.getThinkingBorderColor = function patchedThinkingBorderColor(level: unknown): (str: string) => string {
		const passthrough = original.call(this, level);
		return (str: string): string => {
			if (resolveFooterSettings(readSettings().values).editorBorder !== "gray") return passthrough(str);
			try {
				return this.fg("borderMuted", str);
			} catch {
				return `${FALLBACK_BORDER_GRAY}${str}${RESET}`;
			}
		};
	};
	proto[BORDER_PATCH_FLAG] = true;
}
