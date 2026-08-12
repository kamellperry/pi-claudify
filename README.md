# pi-claudify

Claude Code style rendering for [pi](https://github.com/earendil-works/pi), published as `@owlburtoe/pi-claudify` (formerly `@owlburtoe/pi-cc-tools`). Tool rows, diffs, and transcript grammar that match what Claude Code actually prints, captured from live sessions instead of guessed.

## Why this exists

I trust Claude Code, and most of that trust comes from its harness and TUI. The transcript stays calm. Every tool call gets a short plain row that tells me what the agent did and whether it worked, and nothing shouts for attention. I can read a whole turn at a glance because the terminal is doing the explaining for me.

When I moved to pi, the agent underneath was great but the transcript was not giving me that same feeling. Tool output was boxy and loud, results took up more room than they earned, and I kept expanding things just to confirm the agent was fine. So this package teaches pi to render its transcript the way Claude Code does, because that rendering is what made me comfortable letting an agent work.

This project began as a fork of [pi-cc-tools](https://github.com/FammasMaz/pi-cc-tools) by Moeeze Hassan ([FammasMaz](https://github.com/FammasMaz)), and his tool renderers are still the foundation. Since then I have rebuilt a lot of it and added the conformance layer, the aggregation and message chrome modules, and the test suite, so it now lives here as its own project.

One rule drives the work: capture, do not guess. When I wanted to know how Claude Code renders MCP calls, I ran Claude Code against a throwaway MCP server and recorded the screen through the whole turn. It turned out Claude gives MCP calls no tool row at all, which no amount of guessing would have produced. Each rendering detail gets captured live and written down in [docs/plans/](docs/plans/) before any code changes, and the tests assert the capture. At the end of the day, a faithful copy of the real thing beats a nice invention.

## What it does

- Tool rows in Claude Code's shape: `⏺ Tool(args)` headers, `⎿` result rows, and a status bullet that goes from gray to green when the tool succeeds (red when it fails). Tool names are bold, and file paths are OSC 8 hyperlinks you can click to open the file.
- Read-only tools (`read`, `grep`, `find`, `ls`, `bash`) aggregate under one gerund header while they run, such as `⏺ Searching for 1 pattern, reading 2 files…`, then collapse to a dim past-tense summary like `Read 1 file, ran 1 shell command` once the turn settles. Mutating tools (`write`, `edit`, `apply_patch`) keep their own rows.
- MCP calls render the way Claude Code renders them, which is barely at all. No header, no result row, no arguments. An MCP call adds one clause naming the server to the aggregated group: `⏺ Calling plane, forgejo 2 times…` while running, `Called plane, forgejo 2 times` when done. This works for every MCP server and both of pi's exposure modes, with nothing server-specific hardcoded. Set `readOnlyToolGrouping: false` if you want per-call rows instead.
- Diffs use Claude Code's exact red and green palette, always unified, with a line-number gutter and no box chrome. Removed lines are left without syntax highlighting because Claude Code leaves them plain too.
- Results read as sentences, such as `Wrote 3 lines to <path>` and `Added 2 lines, removed 2 lines`, instead of stat bars.
- Common read-only shell one-liners render semantically, so `nl -ba file | sed -n '1,200p'` shows up as `Read file (lines 1-200)`.
- Transcript grammar matches Claude Code v2.1.207: `❯` user rows with no box, `⏺` bullets at column 0, `(ctrl+o to expand)` hints, and `✻ Cooked for 8s` worked lines. See [docs/plans/2026-07-13-current-cc-grammar.md](docs/plans/2026-07-13-current-cc-grammar.md).
- OpenAI-style tools get the same treatment: `apply_patch` renders parsed diff previews in the call phase, and `webfetch`, `web_search`, `fetch_content`, task tools, and context tools get Claude-style rows.
- The palette follows your active pi theme by default, with borders, connectors, dim text, spinner accent, and diff backgrounds re-derived on every theme change. Thinking labels, message spacing, spinner verbs, and worked verbs are all configurable.

## Requirements

pi 0.74.0 or newer. pi renamed its npm scope from `@mariozechner/*` to `@earendil-works/*` in 0.74.0, and this package imports the new scope. If you are on an older pi, run `pi update` first.

## Configuration

Open the Claudify screen with `/claudify`. From the Hub, use the arrow keys to choose a Section and press Enter to open it. Press Esc to return to the Hub, then Esc again to close the screen.

Most rows save as soon as they change. Pickers preview the highlighted choice live; Enter commits it, while Esc cancels the preview and restores the saved value.

### Sections

#### Theme

- **Adaptive colors** (`themeAdaptive`) controls whether borders, connectors, spinner accents, and eligible diff colors follow the active pi theme.
- **Diff palette** (`diffPalette`) switches between the fixed Claude Code palette and theme-derived diff colors.
- **Tool chrome** (`toolChrome`) switches between Claude-style status bullets and pi theme accents.
- **Diff theme** (`diffTheme`) is a live-preview Picker over the available diff presets.

#### Diffs

- **Collapsed diff lines** (`diffCollapsedLines`) sets how many diff lines remain visible before a diff collapses.

#### Spinner

- **Spinner color** (`spinnerColor`) and **Status color** (`spinnerStatusColor`) are live-preview Pickers over pi theme color keys.
- **While working** edits the present-tense Spinner verb pool (`spinnerVerbs`) used in lines such as `✻ Reviewing…`.
- **After finishing** edits the past-tense Worked verb pool (`workedVerbs`) used in lines such as `✻ Polished for 8s`.

Each verb editor has a mode row for **append** versus **replace**, an **Add…** row for new verbs or phrases, and removal with Backspace or Delete. Append mode combines custom verbs with the built-in pool; replace mode uses only custom verbs, with a safe fallback to the built-ins when the custom list is empty.

#### Messages

- **Message style** (`messageStyle`) chooses Claude-style or classic transcript rhythm.
- **Assistant prefix** (`assistantPrefix`) and **Thinking prefix** (`thinkingPrefix`) control the visible message glyphs or text.
- **Message spacing** (`messageSpacing`) chooses compact or comfortable paragraph spacing.
- **Hidden thinking label** (`hiddenThinkingLabel`) controls the text shown when thinking content is collapsed.

#### Tool output

- **Tool background** (`toolBackground`) chooses standard pi backgrounds, transparent rows, or outlined rows.
- **MCP output** (`mcpOutputMode`) and **Bash output** (`bashOutputMode`) control their collapsed presentation.
- **Preview lines** (`previewLines`) and **Collapsed Bash lines** (`bashCollapsedLines`) set collapsed preview counts.
- **Stack consecutive Bash** (`bashStackConsecutive`) and **Semantic Bash display** (`bashSemanticDisplay`) control Bash row layout and read-only command labeling.
- **Group read-only tools** (`readOnlyToolGrouping`) and **Read-only group limit** (`readOnlyToolGroupLimit`) control inspection aggregation.
- **Expanded preview max lines** (`expandedPreviewMaxLines`) caps fully expanded output.

### Migration from 1.x

The 2.0.0 release removes the legacy runtime commands. Their settings now live here:

| Removed command | Now in the `/claudify` screen |
| --- | --- |
| `/cc-tools <mode>` | Tool output → **Tool background** |
| `/cc-theme on\|off` | Theme → **Adaptive colors** |
| `/cc-spinner color\|status <key>` | Spinner → **Spinner color** / **Status color** Pickers |
| `/cc-spinner verbs …` | Spinner → **While working** verb editor |
| `/cc-message style\|spacing\|…-prefix\|hidden-thinking-label` | Messages → the matching rows |
| `/cc-message verbs …` | Spinner → **After finishing** verb editor |

The screen writes user-scoped settings to `~/.pi/settings.json`. Settings written by 1.x remain compatible: `spinnerVerbColor` is read as `spinnerColor`, and `toolBackground: "border"` is read as `"outlines"`.

## Notes

This package targets recent pi versions where tool renderers use:

- `renderCall(args, theme, context)`
- `renderResult(result, { expanded, isPartial }, theme, context)`

Unknown and custom tools do not have a public global renderer hook in pi, so this package patches container rendering to add top and bottom borders for all tool executions in border mode.

## Credits

This project would not exist without the people whose work it builds on:

- **Moeeze Hassan ([FammasMaz](https://github.com/FammasMaz))**, who wrote [pi-cc-tools](https://github.com/FammasMaz/pi-cc-tools), the project this one was forked from. The bones of the tool renderers are his.
- **[@heyhuynhgiabuu/pi-pretty](https://github.com/buddingnewinsights/pi-pretty)** by [huynhgiabuu](https://github.com/buddingnewinsights): pretty terminal output with syntax-highlighted file reads, colored bash output, and tree-view directory listings
- **[@heyhuynhgiabuu/pi-diff](https://github.com/buddingnewinsights/pi-diff)** by [huynhgiabuu](https://github.com/buddingnewinsights): Shiki-powered terminal diff renderer with word-level diffs in split and unified views
- **[pi-tool-display](https://github.com/MasuRii/pi-tool-display)** by [MasuRii](https://github.com/MasuRii): compact tool call rendering, diff visualization, and output truncation
