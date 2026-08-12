import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

import { DEFAULT_FOOTER_COLOR, normalizeHexColor } from "./footer.ts";
import {
	MAX_CUSTOM_WORKED_VERBS,
	MAX_WORKED_VERB_LENGTH,
	resolveMessageChromeSettings,
	sanitizeWorkedVerbs,
} from "./message-chrome.ts";
import { readSettings, writeSettingsKey, type SettingsFile } from "./settings.ts";
import {
	MAX_CUSTOM_SPINNER_VERBS,
	MAX_SPINNER_VERB_LENGTH,
	sanitizeSpinnerVerbs,
} from "./spinner.ts";

export interface ClaudifySection {
	readonly id: "theme" | "diffs" | "spinner" | "messages" | "tool-output" | "footer";
	readonly label: "Theme" | "Diffs" | "Spinner" | "Messages" | "Tool output" | "Footer";
	readonly placeholder: string;
}

export const CLAUDIFY_SECTIONS: readonly ClaudifySection[] = [
	{ id: "theme", label: "Theme", placeholder: "Theme settings — coming soon" },
	{ id: "diffs", label: "Diffs", placeholder: "Diff settings — coming soon" },
	{ id: "spinner", label: "Spinner", placeholder: "Spinner settings — coming soon" },
	{ id: "messages", label: "Messages", placeholder: "Message settings — coming soon" },
	{ id: "tool-output", label: "Tool output", placeholder: "Tool output settings — coming soon" },
	{ id: "footer", label: "Footer", placeholder: "Footer settings — coming soon" },
];

type MessageTextSettingsKey = "assistantPrefix" | "thinkingPrefix" | "hiddenThinkingLabel";
type TextRowSettingsKey = MessageTextSettingsKey | "footerColor" | "accentColor" | "userMessageBox";
type PickerSettingsKey = "diffTheme" | "spinnerColor" | "spinnerStatusColor";
type VerbListSettingsKey = "spinnerVerbs" | "workedVerbs";
type VerbModeSettingsKey = "spinnerVerbMode" | "workedVerbMode";
type VerbMode = "append" | "replace";

type EditableSettingsKey =
	| "themeAdaptive"
	| "diffPalette"
	| "diffTheme"
	| "toolChrome"
	| "diffCollapsedLines"
	| "spinnerColor"
	| "spinnerStatusColor"
	| "spinnerShimmer"
	| "spinnerVerbs"
	| "spinnerVerbMode"
	| "workedVerbs"
	| "workedVerbMode"
	| "toolBackground"
	| "mcpOutputMode"
	| "bashOutputMode"
	| "previewLines"
	| "bashCollapsedLines"
	| "bashStackConsecutive"
	| "bashSemanticDisplay"
	| "readOnlyToolGrouping"
	| "readOnlyToolGroupLimit"
	| "expandedPreviewMaxLines"
	| "messageStyle"
	| "assistantPrefix"
	| "thinkingPrefix"
	| "messageSpacing"
	| "hiddenThinkingLabel"
	| "footerStyle"
	| "footerColorMode"
	| "footerColor"
	| "footerUsageBar"
	| "footerEffort"
	| "editorBorder"
	| "accentColor"
	| "userMessageBox";

const CLAUDE_AUTHENTIC: Partial<Record<EditableSettingsKey, string>> = {
	// docs/plans/2026-07-13-mcp-grammar.md:13-17 — no per-call MCP result row or preview.
	mcpOutputMode: "hidden",
};

interface SettingRowBase {
	readonly key: EditableSettingsKey;
	readonly label: string;
	readonly description: string;
	readonly value: string | number | boolean | undefined;
}

interface EnumSettingRow extends SettingRowBase {
	readonly kind: "enum";
	readonly value: string;
	readonly values: readonly string[];
	readonly claudeValue?: string;
}

interface BooleanSettingRow extends SettingRowBase {
	readonly kind: "boolean";
	readonly value: boolean;
}

interface NumberSettingRow extends SettingRowBase {
	readonly kind: "number";
	readonly value: number;
	readonly min: number;
	readonly max?: number;
}

interface TextSettingRow extends SettingRowBase {
	readonly kind: "text";
	readonly key: TextRowSettingsKey;
	readonly value: string;
}

interface PickerCandidate {
	readonly label: string;
	readonly value: string | undefined;
}

interface PickerSettingRow extends SettingRowBase {
	readonly kind: "picker";
	readonly key: PickerSettingsKey;
	readonly value: string | undefined;
	readonly candidates: readonly PickerCandidate[];
}

interface VerbEditorSettingRow {
	readonly kind: "verbs";
	readonly key: VerbListSettingsKey;
	readonly modeKey: VerbModeSettingsKey;
	readonly label: string;
	readonly description: string;
	readonly value: readonly string[];
	readonly mode: VerbMode;
	readonly maxEntries: number;
	readonly maxLength: number;
	readonly sanitize: (value: unknown) => string[];
}

type SettingRow = EnumSettingRow | BooleanSettingRow | NumberSettingRow | TextSettingRow | PickerSettingRow | VerbEditorSettingRow;

interface PickerState {
	readonly rowIndex: number;
	readonly highlightedIndex: number;
	readonly committedValue: string | undefined;
}

interface VerbEditorState {
	readonly rowIndex: number;
	readonly selectedIndex: number;
	readonly adding: boolean;
}

type ClaudifyScreenState =
	| { readonly kind: "hub"; readonly selectedIndex: number }
	| {
		readonly kind: "section";
		readonly section: ClaudifySection;
		readonly hubSelectedIndex: number;
		readonly selectedIndex: number;
		readonly editing: boolean;
		readonly picker: PickerState | null;
		readonly verbEditor: VerbEditorState | null;
	};

export interface ClaudifyPickerCandidates {
	readonly diffThemes: readonly string[];
	readonly colorKeys: readonly string[];
}

export type SettingPreviewValue = string | null | undefined;

type RenderRequester = Pick<TUI, "requestRender"> & Partial<Pick<TUI, "terminal">>;

// The Extensions Manager sizes its list body to `terminal.rows - 12`, which makes its
// whole framed panel about `rows - 5` tall (2 rules + title + stats + 2 spacers + footer
// around that list). We mirror that so /claudify fills the viewport the same way instead of
// collapsing to a tiny top-anchored block. See docs/plans/2026-07-16-claudify-framed-panel.md.
const PANEL_HEIGHT_RESERVE = 5;
type ScreenKeybindings = Pick<KeybindingsManager, "matches">;
type SettingChangeHandler = (key: EditableSettingsKey, value: unknown) => void;
type SettingPreviewHandler = (key: PickerSettingsKey, value: SettingPreviewValue) => void;
type NoticeType = "info" | "warning" | "error";
type NotifyHandler = (message: string, type?: NoticeType) => void;

interface ScreenNotice {
	readonly message: string;
	readonly type: NoticeType;
}

interface EnumRowDefinition {
	readonly kind: "enum";
	readonly key: EditableSettingsKey;
	readonly label: string;
	readonly description: string;
	readonly values: readonly string[];
	readonly defaultValue: string;
	readonly claudeValue?: string;
}

interface BooleanRowDefinition {
	readonly kind: "boolean";
	readonly key: EditableSettingsKey;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: boolean;
}

interface NumberRowDefinition {
	readonly kind: "number";
	readonly key: EditableSettingsKey;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: number;
	readonly min: number;
	readonly max?: number;
}

type ImmediateRowDefinition = EnumRowDefinition | BooleanRowDefinition | NumberRowDefinition;

const THEME_ROWS: readonly ImmediateRowDefinition[] = [
	{
		kind: "boolean",
		key: "themeAdaptive",
		label: "Adaptive colors",
		description: "Derives Spinner, border, and automatic diff colors from pi's theme.",
		defaultValue: true,
	},
	{
		kind: "enum",
		key: "diffPalette",
		label: "Diff palette",
		description: "Uses Claude's fixed unified diffs or pi theme-derived colors and layout.",
		values: ["claude", "theme"],
		defaultValue: "claude",
	},
	{
		kind: "enum",
		key: "toolChrome",
		label: "Tool chrome",
		description: "Uses Claude or theme chrome for tool bullets, names, paths, and results.",
		values: ["claude", "theme"],
		defaultValue: "claude",
	},
];

const DIFF_ROWS: readonly ImmediateRowDefinition[] = [
	{
		kind: "number",
		key: "diffCollapsedLines",
		label: "Collapsed Write lines",
		// Write-scoped by name, deliberately (CLFY-23). Only the write tool reads
		// diffCollapsedLimit(); edit's collapsed diff renders a larger fixed budget
		// (renderEditPreviewBody in index.ts). Claude Code never collapses edit diffs
		// at all — it shows them in full (capture: docs/plans/2026-07-17-cc-edit-diff-collapse.md)
		// — so the larger edit budget is the more CC-faithful of the two, and a generic
		// "diff" label would promise a control the user cannot feel on Update rows.
		description: "Limits lines shown in collapsed Write diff previews.",
		defaultValue: 10,
		min: 0,
	},
];

const TOOL_OUTPUT_ROWS: readonly ImmediateRowDefinition[] = [
	{
		kind: "enum",
		key: "toolBackground",
		label: "Tool background",
		description: "Keeps pi backgrounds, clears them, or outlines tool rows horizontally.",
		values: ["default", "transparent", "outlines"],
		defaultValue: "transparent",
	},
	// readOutputMode / searchOutputMode intentionally omitted: no renderer reads
	// them yet, so exposing them as immediate-commit rows would be controls that
	// persist but change nothing in the transcript. Re-add once the read/grep
	// result handlers consume them (tracked as a CLFY-4 follow-up).
	{
		kind: "enum",
		key: "mcpOutputMode",
		label: "MCP output",
		description: "Hides MCP results, shows a status summary, or previews their payload.",
		values: ["hidden", "summary", "preview"],
		defaultValue: "preview",
		claudeValue: CLAUDE_AUTHENTIC.mcpOutputMode,
	},
	{
		kind: "enum",
		key: "bashOutputMode",
		label: "Bash output",
		description: "Chooses expandable, summary-only, or inline-preview Bash results.",
		values: ["opencode", "summary", "preview"],
		defaultValue: "opencode",
	},
	{
		kind: "number",
		key: "previewLines",
		label: "Preview lines",
		description: "Limits lines or items in compact tool previews and expanded file listings.",
		defaultValue: 8,
		min: 1,
	},
	{
		kind: "number",
		key: "bashCollapsedLines",
		label: "Collapsed Bash lines",
		description: "Limits output lines shown by Bash preview mode before expansion.",
		defaultValue: 10,
		min: 0,
	},
	{
		kind: "boolean",
		key: "bashStackConsecutive",
		label: "Stack consecutive Bash",
		description: "Removes gaps between consecutive Bash rows outside grouped summaries.",
		defaultValue: true,
	},
	{
		kind: "boolean",
		key: "bashSemanticDisplay",
		label: "Semantic Bash display",
		description: "Renders simple cat, head, tail, sed, and nl file reads as Read calls.",
		defaultValue: true,
	},
	{
		kind: "boolean",
		key: "readOnlyToolGrouping",
		label: "Group read-only tools",
		description: "Groups Read, search, list, MCP, and Bash calls into Claude summaries.",
		defaultValue: true,
	},
	{
		kind: "number",
		key: "readOnlyToolGroupLimit",
		label: "Read-only group limit",
		description: "Caps visible targets and compact-list entries in grouped tool summaries.",
		defaultValue: 5,
		min: 1,
		max: 20,
	},
	{
		kind: "number",
		key: "expandedPreviewMaxLines",
		label: "Expanded preview max lines",
		description: "Caps lines in expanded output previews that can otherwise grow unbounded.",
		defaultValue: 4000,
		min: 1,
	},
];

// docs/plans/2026-07-16-cc-input-box-footer.md — the Claude Code statusline port
// and the pinned-gray input border. footerColor is a text row, added separately
// in sectionRows so it can sit next to "Color mode".
const FOOTER_ROWS: readonly ImmediateRowDefinition[] = [
	{
		kind: "enum",
		key: "footerStyle",
		label: "Footer style",
		description: "Uses claudify's Claude-style statusline or pi's stock footer.",
		values: ["claude", "pi"],
		defaultValue: "claude",
	},
	{
		kind: "enum",
		key: "footerColorMode",
		label: "Color mode",
		description: "Colors footer segments separately, with one color, or not at all.",
		values: ["colored", "single", "monochrome"],
		defaultValue: "colored",
	},
	{
		kind: "boolean",
		key: "footerUsageBar",
		label: "Usage bar",
		description: "Shows a ten-block bar beside known provider usage percentages.",
		defaultValue: true,
	},
	{
		kind: "boolean",
		key: "footerEffort",
		label: "Effort",
		description: "Appends pi's thinking level to the model name, as in \"Fable 5 · high\".",
		defaultValue: true,
	},
	{
		kind: "enum",
		key: "editorBorder",
		label: "Input border",
		description: "Uses gray or thinking-level input borders; Bash can still recolor them.",
		values: ["gray", "thinking"],
		defaultValue: "gray",
	},
];

class IndentedInput extends Input {
	override render(width: number): string[] {
		return super.render(Math.max(1, width - 3)).map((line) => `   ${line}`);
	}
}

function themedText(theme: Theme, color: "accent" | "dim" | "error" | "success" | "text" | "warning", text: string): string {
	return theme.fg(color, text);
}

function claudeAuthenticMarker(theme: Theme, row: SettingRow): string {
	if (row.kind !== "enum" || row.claudeValue === undefined) return "";
	return row.value === row.claudeValue
		? themedText(theme, "success", "  ✓ Claude")
		: themedText(theme, "dim", `  (Claude: ${row.claudeValue})`);
}

// Color a string by an arbitrary theme color KEY (e.g. a spinner color like
// "borderAccent"). theme.fg() THROWS on a key the active theme doesn't define,
// so a custom/minimal theme missing a COMMON_COLOR_KEYS entry would crash the
// picker render; fall back to plain text color instead of taking the overlay
// down. Mirrors the safeFgAnsi discipline used for the same reason in index.ts.
function themedByKey(theme: Theme, colorKey: string, text: string): string {
	try {
		return theme.fg(colorKey as never, text);
	} catch {
		return themedText(theme, "text", text);
	}
}

function effectiveEnumValue(settings: SettingsFile, definition: EnumRowDefinition): string {
	const value = settings[definition.key];
	return typeof value === "string" && definition.values.includes(value) ? value : definition.defaultValue;
}

function effectiveColorTextValue(value: unknown, keywords: readonly string[], defaultValue: string): string {
	if (typeof value !== "string") return defaultValue;
	const keyword = value.trim().toLowerCase();
	if (keywords.includes(keyword)) return keyword;
	return normalizeHexColor(value) ?? defaultValue;
}

function effectiveNumberValue(settings: SettingsFile, definition: NumberRowDefinition): number {
	const value = settings[definition.key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < definition.min) return definition.defaultValue;
	return Math.min(definition.max ?? Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function immediateRows(settings: SettingsFile, definitions: readonly ImmediateRowDefinition[]): SettingRow[] {
	return definitions.map((definition): SettingRow => {
		if (definition.kind === "enum") return { ...definition, value: effectiveEnumValue(settings, definition) };
		if (definition.kind === "number") return { ...definition, value: effectiveNumberValue(settings, definition) };
		const value = settings[definition.key];
		return { ...definition, value: typeof value === "boolean" ? value : definition.defaultValue };
	});
}

function messageRows(settings: SettingsFile): SettingRow[] {
	const resolved = resolveMessageChromeSettings(settings);
	return [
		{
			kind: "enum",
			key: "messageStyle",
			label: "Message style",
			description: "Switches assistant and thinking rows between classic and Claude chrome.",
			value: resolved.messageStyle,
			values: ["classic", "claude"],
			claudeValue: CLAUDE_AUTHENTIC.messageStyle,
		},
		{
			kind: "text",
			key: "assistantPrefix",
			label: "Assistant prefix",
			description: "Sets the first-line glyph for Claude-style assistant messages.",
			value: resolved.assistantPrefix,
		},
		{
			kind: "text",
			key: "thinkingPrefix",
			label: "Thinking prefix",
			description: "Sets the first-line glyph for Claude-style thinking messages.",
			value: resolved.thinkingPrefix,
		},
		{
			kind: "enum",
			key: "messageSpacing",
			label: "Message spacing",
			description: "Preserves or removes blank lines inside assistant and thinking messages.",
			value: resolved.messageSpacing,
			values: ["compact", "comfortable"],
			claudeValue: CLAUDE_AUTHENTIC.messageSpacing,
		},
		{
			kind: "text",
			key: "hiddenThinkingLabel",
			label: "Hidden thinking label",
			description: "Sets the label shown while hidden thinking is in progress.",
			value: resolved.hiddenThinkingLabel,
		},
		{
			// docs/plans/2026-07-16-cc-user-message-box.md — CC's settled gray block.
			kind: "text",
			key: "userMessageBox",
			label: "User message box",
			description: "Styles user messages with theme, Claude gray, a custom color, or no box.",
			value: effectiveColorTextValue(settings.userMessageBox, ["theme", "claude", "off"], "theme"),
		},
	];
}

function sectionRows(section: ClaudifySection, candidates: ClaudifyPickerCandidates): SettingRow[] {
	const settings = readSettings().values;
	if (section.id === "tool-output") return immediateRows(settings, TOOL_OUTPUT_ROWS);
	if (section.id === "messages") return messageRows(settings);
	if (section.id === "diffs") return immediateRows(settings, DIFF_ROWS);
	if (section.id === "footer") {
		const rows = immediateRows(settings, FOOTER_ROWS);
		const color = typeof settings.footerColor === "string"
			? normalizeHexColor(settings.footerColor) ?? DEFAULT_FOOTER_COLOR
			: DEFAULT_FOOTER_COLOR;
		const colorRow: SettingRow = {
			kind: "text",
			key: "footerColor",
			label: "Color",
			description: "Sets the footer color used in single-color mode.",
			value: color,
		};
		return [...rows.slice(0, 2), colorRow, ...rows.slice(2)];
	}
	if (section.id === "theme") {
		const themeRows = immediateRows(settings, THEME_ROWS);
		const accentRow: SettingRow = {
			// docs/plans/2026-07-16-cc-accent-color.md — CC lavender, pi theme accent, or custom hex.
			kind: "text",
			key: "accentColor",
			label: "Accent",
			description: "Sets selection highlights plus accent-linked inline code and list bullets.",
			value: effectiveColorTextValue(settings.accentColor, ["claude", "theme"], "claude"),
		};
		const diffTheme = typeof settings.diffTheme === "string" && candidates.diffThemes.includes(settings.diffTheme)
			? settings.diffTheme
			: undefined;
		return [
			...themeRows.slice(0, 1),
			accentRow,
			...themeRows.slice(1),
			{
				kind: "picker",
				key: "diffTheme",
				label: "Diff theme",
				description: "Applies a named diff color and syntax-highlighting preset.",
				value: diffTheme,
				candidates: [
					{ label: "None (automatic)", value: undefined },
					...candidates.diffThemes.map((value) => ({ label: value, value })),
				],
			},
		];
	}
	if (section.id === "spinner") {
		const colorCandidates = candidates.colorKeys.map((value) => ({ label: value, value }));
		const spinnerColor = typeof settings.spinnerColor === "string" && candidates.colorKeys.includes(settings.spinnerColor)
			? settings.spinnerColor
			: "borderAccent";
		const statusColor = typeof settings.spinnerStatusColor === "string" && candidates.colorKeys.includes(settings.spinnerStatusColor)
			? settings.spinnerStatusColor
			: "muted";
		return [
			{
				kind: "picker",
				key: "spinnerColor",
				label: "Spinner color",
				description: "Colors the live Spinner glyph and Spinner verb.",
				value: spinnerColor,
				candidates: colorCandidates,
			},
			{
				kind: "picker",
				key: "spinnerStatusColor",
				label: "Status color",
				description: "Colors elapsed time, token counts, and thinking status beside the Spinner.",
				value: statusColor,
				candidates: colorCandidates,
			},
			{
				kind: "verbs",
				key: "spinnerVerbs",
				modeKey: "spinnerVerbMode",
				label: "While working",
				description: "Adds to or replaces the Spinner verb pool shown while a turn runs.",
				value: sanitizeSpinnerVerbs(settings.spinnerVerbs),
				mode: settings.spinnerVerbMode === "replace" ? "replace" : "append",
				maxEntries: MAX_CUSTOM_SPINNER_VERBS,
				maxLength: MAX_SPINNER_VERB_LENGTH,
				sanitize: sanitizeSpinnerVerbs,
			},
			{
				kind: "verbs",
				key: "workedVerbs",
				modeKey: "workedVerbMode",
				label: "After finishing",
				description: "Adds to or replaces the Worked verb pool used after a turn finishes.",
				value: sanitizeWorkedVerbs(settings.workedVerbs),
				mode: settings.workedVerbMode === "replace" ? "replace" : "append",
				maxEntries: MAX_CUSTOM_WORKED_VERBS,
				maxLength: MAX_WORKED_VERB_LENGTH,
				sanitize: sanitizeWorkedVerbs,
			},
			{
				kind: "boolean",
				key: "spinnerShimmer",
				label: "Warm shimmer",
				description: "Animates the Spinner: warms salmon→gold, then loops a sweep and a breathing pulse. Default Spinner color only.",
				value: settings.spinnerShimmer !== false,
			},
		];
	}
	return [];
}

export class ClaudifyScreen extends Container implements Focusable {
	private readonly content = new Container();
	private readonly tui: RenderRequester;
	private readonly theme: Theme;
	private readonly keybindings: ScreenKeybindings;
	private readonly onClose: () => void;
	private readonly onSettingChange?: SettingChangeHandler;
	private readonly onSettingPreview?: SettingPreviewHandler;
	private readonly pickerCandidates: ClaudifyPickerCandidates;
	private readonly onNotify?: NotifyHandler;
	private state: ClaudifyScreenState = { kind: "hub", selectedIndex: 0 };
	private input: IndentedInput | null = null;
	private activePreviewKey: PickerSettingsKey | null = null;
	private notice: ScreenNotice | null = null;
	private footerLine = "";
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	constructor(
		tui: RenderRequester,
		theme: Theme,
		keybindings: ScreenKeybindings,
		onClose: () => void,
		onSettingChange?: SettingChangeHandler,
		onSettingPreview?: SettingPreviewHandler,
		pickerCandidates: ClaudifyPickerCandidates = { diffThemes: [], colorKeys: [] },
		onNotify?: NotifyHandler,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onClose = onClose;
		this.onSettingChange = onSettingChange;
		this.onSettingPreview = onSettingPreview;
		this.pickerCandidates = pickerCandidates;
		this.onNotify = onNotify;
		this.addChild(this.content);
		this.renderState();
	}

	handleInput(data: string): void {
		this.notice = null;
		if (this.state.kind === "section" && this.state.verbEditor) {
			this.handleVerbEditorInput(data);
			return;
		}
		if (this.state.kind === "section" && this.state.editing) {
			this.handleTextInput(data);
			return;
		}
		if (this.state.kind === "section" && this.state.picker) {
			this.handlePickerInput(data);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.handleEscape();
			return;
		}
		if (this.state.kind === "hub") {
			this.handleHubInput(data);
			return;
		}
		this.handleSectionInput(data);
	}

	private handleHubInput(data: string): void {
		if (this.state.kind !== "hub") return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.updateHubSelection(Math.max(0, this.state.selectedIndex - 1));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.updateHubSelection(Math.min(CLAUDIFY_SECTIONS.length - 1, this.state.selectedIndex + 1));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const section = CLAUDIFY_SECTIONS[this.state.selectedIndex];
			if (!section) return;
			this.state = {
				kind: "section",
				section,
				hubSelectedIndex: this.state.selectedIndex,
				selectedIndex: 0,
				editing: false,
				picker: null,
				verbEditor: null,
			};
			this.renderState();
		}
	}

	private handleSectionInput(data: string): void {
		if (this.state.kind !== "section") return;
		const rows = sectionRows(this.state.section, this.pickerCandidates);
		if (rows.length === 0) return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.updateSectionSelection(Math.max(0, this.state.selectedIndex - 1));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.updateSectionSelection(Math.min(rows.length - 1, this.state.selectedIndex + 1));
			return;
		}

		const row = rows[this.state.selectedIndex];
		if (!row) return;
		const confirms = this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.space);
		if (row.kind === "boolean" && confirms) {
			this.commitSetting(row.key, !row.value);
			return;
		}
		if (row.kind === "enum" && (confirms || this.isLeft(data) || this.isRight(data))) {
			const direction = this.isLeft(data) ? -1 : 1;
			const currentIndex = row.values.indexOf(row.value);
			const nextIndex = (currentIndex + direction + row.values.length) % row.values.length;
			this.commitSetting(row.key, row.values[nextIndex]);
			return;
		}
		if (row.kind === "number" && (this.isLeft(data) || this.isRight(data))) {
			const delta = this.isLeft(data) ? -1 : 1;
			const next = Math.max(row.min, Math.min(row.max ?? Number.MAX_SAFE_INTEGER, row.value + delta));
			if (next !== row.value) this.commitSetting(row.key, next);
			return;
		}
		if (row.kind === "text" && this.keybindings.matches(data, "tui.select.confirm")) {
			this.beginTextInput();
			return;
		}
		if (row.kind === "picker" && this.keybindings.matches(data, "tui.select.confirm")) {
			this.beginPicker(row);
			return;
		}
		if (row.kind === "verbs" && this.keybindings.matches(data, "tui.select.confirm")) {
			this.beginVerbEditor();
		}
	}

	private handleVerbEditorInput(data: string): void {
		if (this.state.kind !== "section" || !this.state.verbEditor) return;
		const rows = sectionRows(this.state.section, this.pickerCandidates);
		const row = rows[this.state.verbEditor.rowIndex];
		if (!row || row.kind !== "verbs") return;

		if (this.state.verbEditor.adding) {
			this.handleVerbTextInput(data, row);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finishVerbEditor();
			return;
		}

		const lastIndex = row.value.length + 1;
		let selectedIndex = this.state.verbEditor.selectedIndex;
		if (this.keybindings.matches(data, "tui.select.up")) selectedIndex = Math.max(0, selectedIndex - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) selectedIndex = Math.min(lastIndex, selectedIndex + 1);
		else if (this.isRemove(data)) {
			this.removeSelectedVerb(row);
			return;
		} else {
			const confirms = this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.space);
			if (!confirms) return;
			if (selectedIndex === 0) {
				this.commitSetting(row.modeKey, row.mode === "append" ? "replace" : "append");
				return;
			}
			if (selectedIndex === lastIndex) this.beginVerbTextInput();
			return;
		}
		if (selectedIndex === this.state.verbEditor.selectedIndex) return;
		this.state = { ...this.state, verbEditor: { ...this.state.verbEditor, selectedIndex } };
		this.renderState();
	}

	private handleVerbTextInput(data: string, row: VerbEditorSettingRow): void {
		if (this.state.kind !== "section" || !this.state.verbEditor?.adding || !this.input) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finishVerbTextInput();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const rawValue = this.input.getValue();
			const sanitizedValue = row.sanitize([rawValue])[0];
			this.finishVerbTextInput(false);
			if (!sanitizedValue) {
				this.showNotice("Enter a verb or phrase before adding.", "warning");
				this.renderState();
				return;
			}

			const shortened = Array.from(rawValue.trim()).length > row.maxLength;
			const duplicate = row.value.some((value) => value.toLocaleLowerCase() === sanitizedValue.toLocaleLowerCase());
			if (duplicate) {
				const message = shortened
					? `Phrase shortened to ${row.maxLength} characters; that verb or phrase is already in this list.`
					: "That verb or phrase is already in this list.";
				this.showNotice(message, "warning");
				this.renderState();
				return;
			}
			if (row.value.length >= row.maxEntries) {
				this.showNotice(`Limit reached: ${row.maxEntries} custom entries.`, "warning");
				this.renderState();
				return;
			}

			const next = row.sanitize([...row.value, rawValue]);
			const saved = this.commitSetting(row.key, next, false);
			if (saved && shortened) this.showNotice(`Phrase shortened to ${row.maxLength} characters.`, "warning");
			this.renderState();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private handlePickerInput(data: string): void {
		if (this.state.kind !== "section" || !this.state.picker) return;
		const rows = sectionRows(this.state.section, this.pickerCandidates);
		const row = rows[this.state.picker.rowIndex];
		if (!row || row.kind !== "picker") return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finishPicker();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const candidate = row.candidates[this.state.picker.highlightedIndex];
			if (!candidate) return;
			if (!this.saveSetting(row.key, candidate.value)) {
				this.renderState();
				return;
			}
			this.finishPicker(false);
			this.onSettingChange?.(row.key, candidate.value);
			this.renderState();
			return;
		}
		let highlightedIndex = this.state.picker.highlightedIndex;
		if (this.keybindings.matches(data, "tui.select.up")) highlightedIndex = Math.max(0, highlightedIndex - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) highlightedIndex = Math.min(row.candidates.length - 1, highlightedIndex + 1);
		else return;
		if (highlightedIndex === this.state.picker.highlightedIndex) return;
		this.state = { ...this.state, picker: { ...this.state.picker, highlightedIndex } };
		const value = row.candidates[highlightedIndex]?.value;
		this.previewSetting(row.key, value === undefined ? null : value);
		this.renderState();
	}

	private handleTextInput(data: string): void {
		if (this.state.kind !== "section" || !this.state.editing || !this.input) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finishTextInput();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.submitTextInput(this.input.getValue());
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private isLeft(data: string): boolean {
		return this.keybindings.matches(data, "tui.editor.cursorLeft") || matchesKey(data, Key.left);
	}

	private isRight(data: string): boolean {
		return this.keybindings.matches(data, "tui.editor.cursorRight") || matchesKey(data, Key.right);
	}

	private isRemove(data: string): boolean {
		return this.keybindings.matches(data, "tui.editor.deleteCharBackward")
			|| this.keybindings.matches(data, "tui.editor.deleteCharForward")
			|| matchesKey(data, Key.backspace)
			|| matchesKey(data, Key.delete);
	}

	private handleEscape(): void {
		if (this.state.kind === "hub") {
			this.clearActivePreview();
			this.onClose();
			return;
		}
		this.clearActivePreview();
		this.state = { kind: "hub", selectedIndex: this.state.hubSelectedIndex };
		this.renderState();
	}

	private updateHubSelection(selectedIndex: number): void {
		if (this.state.kind !== "hub" || selectedIndex === this.state.selectedIndex) return;
		this.state = { kind: "hub", selectedIndex };
		this.renderState();
	}

	private updateSectionSelection(selectedIndex: number): void {
		if (this.state.kind !== "section" || selectedIndex === this.state.selectedIndex) return;
		this.state = { ...this.state, selectedIndex };
		this.renderState();
	}

	private saveSetting(key: EditableSettingsKey, value: unknown): boolean {
		const result = writeSettingsKey(key, value);
		if (!result.success) {
			const message = result.backupCreated
				? "Backed up to ~/.pi/settings.json.bak, but couldn't save to ~/.pi/settings.json"
				: "Couldn't save to ~/.pi/settings.json";
			this.showNotice(message, "error");
			return false;
		}
		if (result.backupCreated) {
			this.showNotice("Backed up invalid settings to ~/.pi/settings.json.bak", "warning");
		}
		return true;
	}

	private commitSetting(key: EditableSettingsKey, value: unknown, render = true): boolean {
		if (!this.saveSetting(key, value)) {
			if (render) this.renderState();
			return false;
		}
		this.onSettingChange?.(key, value);
		if (render) this.renderState();
		return true;
	}

	private showNotice(message: string, type: NoticeType): void {
		this.notice = { message, type };
		this.onNotify?.(message, type);
	}

	private previewSetting(key: PickerSettingsKey, value: SettingPreviewValue): void {
		this.activePreviewKey = key;
		this.onSettingPreview?.(key, value);
	}

	private clearActivePreview(): void {
		if (!this.activePreviewKey) return;
		this.onSettingPreview?.(this.activePreviewKey, undefined);
		this.activePreviewKey = null;
	}

	private beginPicker(row: PickerSettingRow): void {
		if (this.state.kind !== "section" || row.candidates.length === 0) return;
		const committedIndex = row.candidates.findIndex((candidate) => candidate.value === row.value);
		this.state = {
			...this.state,
			picker: {
				rowIndex: this.state.selectedIndex,
				highlightedIndex: committedIndex >= 0 ? committedIndex : 0,
				committedValue: row.value,
			},
		};
		this.renderState();
	}

	private beginVerbEditor(): void {
		if (this.state.kind !== "section") return;
		this.state = {
			...this.state,
			verbEditor: { rowIndex: this.state.selectedIndex, selectedIndex: 0, adding: false },
		};
		this.renderState();
	}

	private finishVerbEditor(): void {
		if (this.state.kind !== "section" || !this.state.verbEditor) return;
		this.state = { ...this.state, verbEditor: null };
		this.renderState();
	}

	private beginVerbTextInput(): void {
		if (this.state.kind !== "section" || !this.state.verbEditor) return;
		this.state = { ...this.state, verbEditor: { ...this.state.verbEditor, adding: true } };
		this.renderState();
		this.input?.setValue("");
		this.tui.requestRender();
	}

	private finishVerbTextInput(render = true): void {
		if (this.state.kind !== "section" || !this.state.verbEditor) return;
		this.state = { ...this.state, verbEditor: { ...this.state.verbEditor, adding: false } };
		this.input = null;
		if (render) this.renderState();
	}

	private removeSelectedVerb(row: VerbEditorSettingRow): void {
		if (this.state.kind !== "section" || !this.state.verbEditor) return;
		const verb = row.value[this.state.verbEditor.selectedIndex - 1];
		if (!verb) return;
		const removeKey = verb.toLocaleLowerCase();
		const next = row.value.filter((item) => item.toLocaleLowerCase() !== removeKey);
		const selectedIndex = Math.min(this.state.verbEditor.selectedIndex, next.length + 1);
		this.state = { ...this.state, verbEditor: { ...this.state.verbEditor, selectedIndex } };
		this.commitSetting(row.key, next.length > 0 ? next : undefined);
	}

	private finishPicker(render = true): void {
		if (this.state.kind !== "section" || !this.state.picker) return;
		this.clearActivePreview();
		this.state = { ...this.state, picker: null };
		if (render) this.renderState();
	}

	private beginTextInput(): void {
		if (this.state.kind !== "section") return;
		this.state = { ...this.state, editing: true };
		this.renderState();
		this.input?.setValue("");
		this.tui.requestRender();
	}

	private submitTextInput(rawValue: string): void {
		if (this.state.kind !== "section") return;
		const row = sectionRows(this.state.section, this.pickerCandidates)[this.state.selectedIndex];
		if (!row || row.kind !== "text") return;
		// An empty/whitespace-only submit cancels rather than resetting to the
		// built-in default: opening a text row (Enter) then a reflexive second
		// Enter must not silently wipe the user's customized prefix/label.
		if (rawValue.trim().length === 0) {
			this.finishTextInput();
			return;
		}
		if (row.key === "footerColor" || row.key === "accentColor" || row.key === "userMessageBox") {
			const keywords = row.key === "accentColor"
				? ["claude", "theme"]
				: row.key === "userMessageBox"
					? ["theme", "claude", "off"]
					: [];
			const keyword = rawValue.trim().toLowerCase();
			const normalized = normalizeHexColor(rawValue) ?? (keywords.includes(keyword) ? keyword : null);
			this.finishTextInput(false);
			if (!normalized) {
				const message = keywords.length > 0
					? `Enter ${keywords.join(", ")}, or a hex color like #FF9200.`
					: "Enter a hex color like #FF9200.";
				this.showNotice(message, "warning");
				this.renderState();
				return;
			}
			this.commitSetting(row.key, normalized);
			return;
		}
		const settings = readSettings().values;
		const resolved = resolveMessageChromeSettings({ ...settings, [row.key]: rawValue });
		this.finishTextInput(false);
		this.commitSetting(row.key, resolved[row.key]);
	}

	private finishTextInput(render = true): void {
		if (this.state.kind !== "section") return;
		this.state = { ...this.state, editing: false };
		this.input = null;
		if (render) this.renderState();
	}

	private renderState(): void {
		this.content.clear();
		this.input = null;
		this.footerLine = "";
		if (this.state.kind === "hub") this.renderHub(this.state.selectedIndex);
		else this.renderSection(this.state);
		this.tui.requestRender();
	}

	// Wrap the body in the Extensions Manager's chrome: an accent rule, a title (+ hub subtitle),
	// the body, height-fill padding, the footer pinned above a closing rule. Rendering inline
	// (the command drops the overlay) plus this fill makes the panel span the viewport instead of
	// collapsing to a tiny top-anchored block. Degrades to natural height when no terminal size is
	// available (e.g. the assembled-render tests construct a `tui` without `.terminal`).
	override render(width: number): string[] {
		const rule = (): string[] => new DynamicBorder((s) => themedText(this.theme, "accent", s)).render(width);
		const line = (text: string): string[] => new Text(text, 2, 0).render(width);

		const head: string[] = [...rule(), ...line(themedText(this.theme, "accent", this.theme.bold("Claudify")))];
		const subtitle = this.subtitle();
		if (subtitle) head.push(...line(themedText(this.theme, "dim", subtitle)));
		head.push("");

		const body = this.content.render(width);
		const footer = [...new Text(this.footerLine, 3, 0).render(width), ...rule()];

		const rows = this.tui.terminal?.rows;
		const naturalHeight = head.length + body.length + footer.length;
		const targetHeight = rows ? rows - PANEL_HEIGHT_RESERVE : 0;
		const gap = Math.max(1, targetHeight - naturalHeight);

		return [...head, ...body, ...Array<string>(gap).fill(""), ...footer];
	}

	private subtitle(): string {
		return this.state.kind === "hub" ? `${CLAUDIFY_SECTIONS.length} sections` : "";
	}

	private renderHub(selectedIndex: number): void {
		for (const [index, section] of CLAUDIFY_SECTIONS.entries()) {
			const selected = index === selectedIndex;
			const marker = selected ? themedText(this.theme, "accent", "❯") : " ";
			const label = themedText(this.theme, "text", section.label);
			this.content.addChild(new Text(`${marker} ${label}`, 3, 0));
		}
		this.renderFooter("↑/↓ to move · Enter to open · Esc to close");
	}

	private renderSection(state: Extract<ClaudifyScreenState, { kind: "section" }>): void {
		const rows = sectionRows(state.section, this.pickerCandidates);
		if (state.picker) {
			const row = rows[state.picker.rowIndex];
			if (row?.kind === "picker") {
				this.renderPicker(state.section, row, state.picker);
				return;
			}
		}
		if (state.verbEditor) {
			const row = rows[state.verbEditor.rowIndex];
			if (row?.kind === "verbs") {
				this.renderVerbEditor(state.section, row, state.verbEditor);
				return;
			}
		}

		this.content.addChild(new Text(themedText(this.theme, "accent", this.theme.bold(state.section.label)), 3, 0));
		this.content.addChild(new Spacer(1));
		if (rows.length === 0) {
			this.content.addChild(new Text(themedText(this.theme, "dim", state.section.placeholder), 3, 0));
			this.renderFooter("Esc to go back");
			return;
		}

		const labelWidth = Math.max(...rows.map((row) => row.label.length)) + 4;
		for (const [index, row] of rows.entries()) {
			const selected = index === state.selectedIndex;
			const marker = selected ? themedText(this.theme, "accent", "❯") : " ";
			const label = themedText(this.theme, "text", row.label.padEnd(labelWidth));
			const displayValue = row.kind === "verbs"
				? `${row.value.length} custom · ${row.mode}`
				: row.kind === "picker" && row.value === undefined ? "none" : String(row.value);
			const value = row.kind === "picker" && row.key !== "diffTheme"
				? themedByKey(this.theme, String(row.value), displayValue)
				: themedText(this.theme, "text", displayValue);
			this.content.addChild(new Text(`${marker} ${label}${value}${claudeAuthenticMarker(this.theme, row)}`, 3, 0));
			if (selected) {
				this.content.addChild(new Text(themedText(this.theme, "dim", `  ${row.description}`), 3, 0));
			}
		}

		if (state.editing) {
			const row = rows[state.selectedIndex];
			this.content.addChild(new Spacer(1));
			this.content.addChild(new Text(themedText(this.theme, "dim", `New value for ${row?.label ?? "setting"}`), 3, 0));
			this.input = new IndentedInput();
			this.input.focused = this.focused;
			this.content.addChild(this.input);
		}

		this.renderFooter(this.sectionFooter(rows[state.selectedIndex], state.editing));
	}

	private renderVerbEditor(section: ClaudifySection, row: VerbEditorSettingRow, editor: VerbEditorState): void {
		this.content.addChild(new Text(themedText(this.theme, "accent", this.theme.bold(section.label)), 3, 0));
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(themedText(this.theme, "text", this.theme.bold(row.label)), 3, 0));
		this.content.addChild(new Spacer(1));

		const modeSelected = editor.selectedIndex === 0;
		const modeMarker = modeSelected ? themedText(this.theme, "accent", "❯") : " ";
		this.content.addChild(new Text(`${modeMarker} ${themedText(this.theme, "text", "Mode")}   ${themedText(this.theme, "text", row.mode)}`, 3, 0));
		for (const [index, verb] of row.value.entries()) {
			const selected = editor.selectedIndex === index + 1;
			const marker = selected ? themedText(this.theme, "accent", "❯") : " ";
			const number = themedText(this.theme, "dim", `${index + 1}.`);
			this.content.addChild(new Text(`${marker} ${number} ${themedText(this.theme, "text", verb)}`, 3, 0));
		}
		if (row.value.length === 0) {
			this.content.addChild(new Text(themedText(this.theme, "dim", "   No custom verbs — using built-ins"), 3, 0));
		}
		const addSelected = editor.selectedIndex === row.value.length + 1;
		const addMarker = addSelected ? themedText(this.theme, "accent", "❯") : " ";
		this.content.addChild(new Text(`${addMarker} ${themedText(this.theme, "text", "Add…")}`, 3, 0));

		if (editor.adding) {
			this.content.addChild(new Spacer(1));
			this.content.addChild(new Text(themedText(this.theme, "dim", `New verb for ${row.label.toLowerCase()}`), 3, 0));
			this.input = new IndentedInput();
			this.input.focused = this.focused;
			this.content.addChild(this.input);
		}

		let footer = "↑/↓ to move · Enter to add · Esc to back";
		if (editor.adding) footer = "Type a verb or phrase · Enter to add · Esc to cancel";
		else if (editor.selectedIndex === 0) footer = "↑/↓ to move · Enter/Space to change · Esc to back";
		else if (editor.selectedIndex <= row.value.length) footer = "↑/↓ to move · Backspace/Delete to remove · Esc to back";
		this.renderFooter(footer);
	}

	private renderPicker(section: ClaudifySection, row: PickerSettingRow, picker: PickerState): void {
		this.content.addChild(new Text(themedText(this.theme, "accent", this.theme.bold(section.label)), 3, 0));
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(themedText(this.theme, "text", `Choose ${row.label.toLowerCase()}`), 3, 0));
		this.content.addChild(new Spacer(1));
		for (const [index, candidate] of row.candidates.entries()) {
			const highlighted = index === picker.highlightedIndex;
			const committed = candidate.value === picker.committedValue;
			const marker = highlighted ? themedText(this.theme, "accent", "❯") : " ";
			const number = themedText(this.theme, "dim", `${index + 1}.`);
			const label = row.key === "diffTheme"
				? themedText(this.theme, "text", candidate.label)
				: themedByKey(this.theme, String(candidate.value ?? ""), candidate.label);
			const check = committed ? ` ${this.theme.fg("success", "✔")}` : "";
			this.content.addChild(new Text(`${marker} ${number} ${label}${check}`, 3, 0));
		}
		this.renderFooter("Enter to select · Esc to cancel");
	}

	// The footer is composed here but rendered by render() below, pinned above the bottom rule
	// with the height-fill padding between it and the body (matching the Extensions Manager).
	private renderFooter(fallback: string): void {
		const color = this.notice?.type === "error" ? "error" : this.notice?.type === "warning" ? "warning" : "dim";
		this.footerLine = themedText(this.theme, color, this.notice?.message ?? fallback);
	}

	private sectionFooter(row: SettingRow | undefined, editing: boolean): string {
		if (editing) return "Type a value · Enter to save · Esc to cancel";
		if (row?.kind === "number") return "↑/↓ to move · ←/→ to change · Esc to back";
		if (row?.kind === "text") return "↑/↓ to move · Enter to edit · Esc to back";
		if (row?.kind === "picker") return "↑/↓ to move · Enter to choose · Esc to back";
		if (row?.kind === "verbs") return "↑/↓ to move · Enter to edit · Esc to back";
		return "↑/↓ to move · Enter/Space to change · Esc to back";
	}
}
