import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const WIDGET_ID = "git-command";
const COMMAND_TIMEOUT_MS = 30_000;
const WIDGET_MAX_LINES = 20;
const MAX_LINE_WIDTH = 400;
const DEFAULT_LOG_LIMIT = 300;
const MAX_SUBJECT_COLUMN_WIDTH = 110;
const FIELD_SEP = "\x1f";

type GitResult = {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	failed?: string;
};

async function runGit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	gitArgs: string,
): Promise<GitResult> {
	try {
		// Run through sh -c so quoting in args (e.g. commit -m "msg") works
		const result = await pi.exec("sh", ["-c", `git ${gitArgs}`], {
			cwd: ctx.cwd,
			timeout: COMMAND_TIMEOUT_MS,
		});
		return {
			ok: result.code === 0,
			code: result.code,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	} catch (error) {
		return {
			ok: false,
			code: null,
			stdout: "",
			stderr: "",
			failed: error instanceof Error ? error.message : String(error),
		};
	}
}

function outputLines(result: GitResult): string[] {
	const raw = [result.stdout, result.stderr]
		.map((s) => s.replace(/\s+$/, ""))
		.filter((s) => s.length > 0)
		.join("\n");
	if (raw.length === 0) return [];
	return raw.split("\n").map((line) => {
		const clean = line.replace(/\t/g, "    ");
		return clean.length > MAX_LINE_WIDTH ? `${clean.slice(0, MAX_LINE_WIDTH - 1)}…` : clean;
	});
}

/** Scrollable read-only pager (less-style) shown via ctx.ui.custom(). */
function showPager(
	ctx: ExtensionCommandContext,
	title: string,
	lines: string[],
): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let offset = 0;

		const pageSize = () => Math.max(5, (tui.terminal?.rows ?? 24) - 7);
		const maxOffset = () => Math.max(0, lines.length - pageSize());
		const clamp = () => {
			if (offset > maxOffset()) offset = maxOffset();
			if (offset < 0) offset = 0;
		};

		return {
			render(width: number): string[] {
				clamp();
				const ps = pageSize();
				const visible = lines.slice(offset, offset + ps);
				const first = lines.length === 0 ? 0 : offset + 1;
				const last = Math.min(offset + ps, lines.length);
				const pct =
					lines.length <= ps
						? "all"
						: offset >= maxOffset()
							? "end"
							: `${Math.round((last / lines.length) * 100)}%`;

				const out: string[] = [];
				out.push(
					truncateToWidth(
						theme.fg("accent", `── ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}`),
						width,
					),
				);
				for (const line of visible) {
					out.push(truncateToWidth(line, width));
				}
				// Pad so the footer doesn't jump around near the end
				for (let i = visible.length; i < ps; i++) out.push("");
				out.push(
					truncateToWidth(
						theme.fg("dim", `lines ${first}-${last} of ${lines.length} (${pct})`),
						width,
					),
				);
				out.push(
					truncateToWidth(
						theme.fg("dim", "↑↓/jk scroll • PgUp/PgDn page • ctrl+u/d half • g/G top/bottom • q/esc close"),
						width,
					),
				);
				return out;
			},
			invalidate() {},
			handleInput(data: string) {
				const ps = pageSize();
				if (matchesKey(data, Key.up) || data === "k") offset -= 1;
				else if (matchesKey(data, Key.down) || data === "j") offset += 1;
				else if (matchesKey(data, Key.pageUp)) offset -= ps;
				else if (matchesKey(data, Key.pageDown) || data === " ") offset += ps;
				else if (matchesKey(data, Key.ctrl("u"))) offset -= Math.ceil(ps / 2);
				else if (matchesKey(data, Key.ctrl("d"))) offset += Math.ceil(ps / 2);
				else if (matchesKey(data, Key.home) || data === "g") offset = 0;
				else if (matchesKey(data, Key.end) || data === "G") offset = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.escape) || data === "q") {
					done();
					return;
				}
				clamp();
				tui.requestRender();
			},
		};
	});
}

type Commit = { sha: string; subject: string; meta: string };

type PickerAction =
	| { type: "insert"; sha: string }
	| { type: "view"; sha: string; index: number }
	| null;

/** Interactive commit picker for `git log` with fuzzy filter, view, and SHA insert. */
async function showLogPicker(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	title: string,
	commits: Commit[],
): Promise<void> {
	const items: SelectItem[] = commits.map((c) => ({
		value: c.sha,
		label: `${c.sha} ${c.subject}`,
		description: c.meta,
	}));

	let selectedIndex = 0;
	let filter = "";

	for (;;) {
		const action = await ctx.ui.custom<PickerAction>((tui, theme, _keybindings, done) => {
			const container = new Container();
			const rows = tui.terminal?.rows ?? 24;
			const maxVisible = Math.max(4, Math.min(items.length, rows - 9));

			const titleText = new Text("", 1, 0);
			const updateTitle = () => {
				const filterPart = filter.length > 0 ? theme.fg("warning", `  filter: ${filter}`) : "";
				titleText.setText(theme.fg("accent", theme.bold(title)) + filterPart);
			};
			updateTitle();
			container.addChild(titleText);

			const list = new SelectList(
				items,
				maxVisible,
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
				{
					// Default primary column is 32 cols, which truncates commit subjects
					// hard. Let it grow to fit the widest "sha subject" up to a sane cap.
					minPrimaryColumnWidth: 40,
					maxPrimaryColumnWidth: MAX_SUBJECT_COLUMN_WIDTH,
				},
			);
			list.setFilter(filter);
			list.setSelectedIndex(selectedIndex);
			list.onSelect = (item) => done({ type: "insert", sha: item.value });
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(
				new Text(
					theme.fg("dim", "↑↓ navigate • type to filter • enter insert sha • tab view commit • esc close"),
					1,
					0,
				),
			);

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					if (matchesKey(data, Key.tab)) {
						const item = list.getSelectedItem();
						if (item) {
							done({ type: "view", sha: item.value, index: items.findIndex((i) => i.value === item.value) });
						}
						return;
					}
					if (matchesKey(data, Key.backspace)) {
						if (filter.length > 0) {
							filter = filter.slice(0, -1);
							list.setFilter(filter);
							updateTitle();
						}
						tui.requestRender();
						return;
					}
					// Printable characters extend the fuzzy filter
					if (data.length === 1 && data >= " " && data <= "~") {
						filter += data;
						list.setFilter(filter);
						updateTitle();
						tui.requestRender();
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!action) return;

		if (action.type === "insert") {
			ctx.ui.pasteToEditor(action.sha);
			return;
		}

		// View commit, then return to picker at the same position
		selectedIndex = Math.max(0, action.index);
		const show = await runGit(pi, ctx, `show ${action.sha}`);
		const lines = outputLines(show);
		if (show.ok && lines.length > 0) {
			await showPager(ctx, `git show ${action.sha}`, lines);
		} else {
			ctx.ui.notify(`git show ${action.sha} failed`, "error");
		}
	}
}

/** True if `/git log ...` args are compatible with the structured commit picker. */
function isPickerFriendlyLog(gitArgs: string): boolean {
	const tokens = gitArgs.split(/\s+/);
	if (tokens[0] !== "log") return false;
	const incompatible = [
		"-p", "--patch", "--stat", "--shortstat", "--numstat", "--name-only",
		"--name-status", "--format", "--pretty", "--oneline", "--graph", "--follow",
	];
	return !tokens.some((t) => incompatible.some((flag) => t === flag || t.startsWith(`${flag}=`)));
}

function hasCountLimit(gitArgs: string): boolean {
	return /(^|\s)(-n\b|-\d|--max-count)/.test(gitArgs);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("git", {
		description: "Run a git command; short output in a widget, long output in a pager (/git clear to dismiss)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				"status", "log", "diff", "add", "commit", "push", "pull", "fetch",
				"branch", "checkout", "switch", "stash", "rebase", "merge", "reset",
				"restore", "cherry-pick", "show", "blame", "remote", "tag", "clear",
			];
			const matches = subcommands.filter((s) => s.startsWith(prefix));
			return matches.length > 0
				? matches.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args, ctx) => {
			const theme = ctx.ui.theme;
			const trimmed = (args ?? "").trim();

			// Dismiss the widget
			if (trimmed === "clear") {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				return;
			}

			// Default to a compact status if no args given
			const gitArgs = trimmed === "" ? "status --short --branch" : trimmed;
			const interactive = ctx.mode === "tui";

			// git log → structured commit picker (when args allow it)
			if (interactive && isPickerFriendlyLog(gitArgs)) {
				const rest = gitArgs.replace(/^log\s*/, "");
				const limit = hasCountLimit(rest) ? "" : ` -n ${DEFAULT_LOG_LIMIT}`;
				const format = `%h${FIELD_SEP}%s${FIELD_SEP}%an, %ar`;
				const result = await runGit(pi, ctx, `log "--format=${format}"${limit} ${rest}`.trim());

				if (result.ok) {
					const commits: Commit[] = result.stdout
						.split("\n")
						.filter((l) => l.includes(FIELD_SEP))
						.map((l) => {
							const [sha = "", subject = "", meta = ""] = l.split(FIELD_SEP);
							return { sha, subject, meta };
						});
					if (commits.length === 0) {
						ctx.ui.setWidget(WIDGET_ID, [
							theme.fg("warning", `git ${gitArgs}: no commits`),
							theme.fg("dim", "/git clear to dismiss"),
						]);
						return;
					}
					await showLogPicker(ctx, pi, `git ${gitArgs}`, commits);
					ctx.ui.setWidget(WIDGET_ID, [
						theme.fg("success", "✓ ") +
							theme.fg("accent", `git ${gitArgs}`) +
							theme.fg("dim", ` — browsed ${commits.length} commits`),
						theme.fg("dim", "/git clear to dismiss"),
					]);
					return;
				}
				// Formatted log failed (bad args, etc.) → fall through to plain execution
			}

			const result = await runGit(pi, ctx, gitArgs);
			const lines = outputLines(result);

			// Long successful output → pager, then compact summary widget
			if (interactive && result.ok && lines.length > WIDGET_MAX_LINES) {
				await showPager(ctx, `git ${gitArgs}`, lines);
				ctx.ui.setWidget(WIDGET_ID, [
					theme.fg("success", "✓ ") +
						theme.fg("accent", `git ${gitArgs}`) +
						theme.fg("dim", ` — ${lines.length} lines (viewed in pager)`),
					theme.fg("dim", "/git clear to dismiss"),
				]);
				return;
			}

			// Short output (or failure, or non-TUI) → widget
			const header = result.ok
				? theme.fg("success", "✓ ") + theme.fg("accent", `git ${gitArgs}`)
				: theme.fg("error", "✗ ") +
					theme.fg("accent", `git ${gitArgs}`) +
					theme.fg("error", result.failed ? ` (${result.failed})` : ` (exit ${result.code})`);

			const shown = lines.slice(0, WIDGET_MAX_LINES);
			const widgetLines: string[] = [header];
			if (shown.length > 0) {
				widgetLines.push(...shown.map((l) => theme.fg(result.ok ? "text" : "warning", l)));
			} else {
				widgetLines.push(theme.fg("dim", "(no output)"));
			}
			if (lines.length > WIDGET_MAX_LINES) {
				widgetLines.push(theme.fg("dim", `… ${lines.length - WIDGET_MAX_LINES} more lines`));
			}
			widgetLines.push(theme.fg("dim", "/git clear to dismiss"));

			ctx.ui.setWidget(WIDGET_ID, widgetLines);
		},
	});
}
