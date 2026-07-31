import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import { emitBranchChange } from "./lib/branch-signal";

// Sorts right after "github-pr" so the stack count sits next to the PR link
// in the footer's single status line (statuses are joined sorted by key).
const STATUS_ID = "github-stack";
const COMMAND_TIMEOUT_MS = 15_000;
const BRANCH_POLL_INTERVAL_MS = 30_000;
const STACK_REFRESH_INTERVAL_MS = 60_000;
const PICKER_SHORTCUT = "alt+s";

/**
 * Structured stash message marker. Brackets delimit the branch name exactly so
 * `pi-stack[foo]` never matches branch `foo-bar`. Git prepends "On <branch>: "
 * to stash messages, so we match on inclusion.
 */
const stashMarker = (branch: string) => `pi-stack[${branch}]`;

type StackBranch = {
	name: string;
	isCurrent: boolean;
	isMerged: boolean;
	needsRebase: boolean;
	pr?: { number: number; url: string; state: string };
};

type StackView = {
	trunk: string;
	currentBranch: string;
	branches: StackBranch[];
};

type StashEntry = { ref: string; message: string };

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let lastBranch: string | undefined;
	let lastStackCheck = 0;

	const exec = (ctx: ExtensionContext, command: string, args: string[]) =>
		pi.exec(command, args, { cwd: ctx.cwd, timeout: COMMAND_TIMEOUT_MS });

	const currentBranch = async (ctx: ExtensionContext): Promise<string> => {
		const result = await exec(ctx, "git", ["branch", "--show-current"]);
		return result.code === 0 ? result.stdout.trim() : "";
	};

	/** Returns the stack containing the current branch, or undefined (exit 2 = not in a stack). */
	const getStackView = async (ctx: ExtensionContext): Promise<StackView | undefined> => {
		try {
			const result = await exec(ctx, "gh", ["stack", "view", "--json"]);
			if (result.code !== 0) return undefined;
			const view = JSON.parse(result.stdout) as StackView;
			return Array.isArray(view.branches) && view.branches.length > 0 ? view : undefined;
		} catch {
			return undefined;
		}
	};

	const listStashes = async (ctx: ExtensionContext): Promise<StashEntry[]> => {
		const result = await exec(ctx, "git", ["stash", "list", "--format=%gd%x1f%gs"]);
		if (result.code !== 0) return [];
		return result.stdout
			.split("\n")
			.filter((l) => l.includes("\x1f"))
			.map((l) => {
				const [ref = "", message = ""] = l.split("\x1f");
				return { ref, message };
			});
	};

	const findStashFor = (stashes: StashEntry[], branch: string): StashEntry | undefined =>
		stashes.find((s) => s.message.includes(stashMarker(branch)));

	const setStackStatus = (ctx: ExtensionContext, view: StackView | undefined, branch: string) => {
		if (!view) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		const index = view.branches.findIndex((b) => b.name === branch);
		if (index === -1) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		const position = `${index + 1}/${view.branches.length}`;
		ctx.ui.setStatus(
			STATUS_ID,
			ctx.ui.theme.fg("accent", `stack ${position}`) +
				ctx.ui.theme.fg("dim", ` (${PICKER_SHORTCUT})`),
		);
	};

	const refresh = async (ctx: ExtensionContext, force = false) => {
		if (refreshing) return;
		refreshing = true;
		try {
			const branch = await currentBranch(ctx);
			if (!branch) {
				lastBranch = undefined;
				lastStackCheck = 0;
				ctx.ui.setStatus(STATUS_ID, undefined);
				return;
			}
			const branchChanged = branch !== lastBranch;
			const refreshDue = Date.now() - lastStackCheck >= STACK_REFRESH_INTERVAL_MS;
			if (!force && !branchChanged && !refreshDue) return;
			lastBranch = branch;
			lastStackCheck = Date.now();
			setStackStatus(ctx, await getStackView(ctx), branch);
		} catch {
			ctx.ui.setStatus(STATUS_ID, undefined);
		} finally {
			refreshing = false;
		}
	};

	/** Picker showing stack members top (furthest from trunk) → bottom → trunk. */
	const pickStackBranch = async (
		ctx: ExtensionContext,
		view: StackView,
		stashes: StashEntry[],
	): Promise<string | undefined> => {
		const ordered = [...view.branches].reverse(); // JSON is bottom→top; show top first
		const items: SelectItem[] = ordered.map((b, i) => {
			const position = view.branches.length - i;
			const marker = b.isCurrent ? "● " : "  ";
			const parts: string[] = [];
			if (b.pr) parts.push(`PR #${b.pr.number} ${b.pr.state}`);
			else parts.push("no PR");
			if (b.isMerged) parts.push("merged");
			if (b.needsRebase) parts.push("needs rebase");
			if (findStashFor(stashes, b.name)) parts.push("⚑ stash");
			if (b.isCurrent) parts.push("current");
			return {
				value: b.name,
				label: `${marker}${position}/${view.branches.length} ${b.name}`,
				description: parts.join(" · "),
			};
		});
		items.push({
			value: view.trunk,
			label: `  ${view.trunk}`,
			description: ["trunk", findStashFor(stashes, view.trunk) ? "⚑ stash" : ""]
				.filter(Boolean)
				.join(" · "),
		});

		return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold(`Stack on ${view.trunk}`)), 1, 0));

			const list = new SelectList(
				items,
				Math.min(items.length, 12),
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
				{ minPrimaryColumnWidth: 40, maxPrimaryColumnWidth: 110 },
			);
			const currentIndex = items.findIndex((i) => i.value === view.currentBranch);
			if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			container.addChild(list);

			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate • enter switch branch • esc cancel"), 1, 0),
			);

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, Key.tab)) return; // avoid focus weirdness
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	/** Switch to `target`, offering to stash dirty changes and pop a prior structured stash. */
	const switchToBranch = async (ctx: ExtensionContext, from: string, target: string) => {
		// Dirty working tree → offer a structured stash
		const status = await exec(ctx, "git", ["status", "--porcelain"]);
		if (status.code !== 0) {
			ctx.ui.notify(`git status failed: ${status.stderr.trim()}`, "error");
			return;
		}
		let stashedRef: string | undefined;
		if (status.stdout.trim()) {
			const fileCount = status.stdout.trim().split("\n").length;
			const choice = await ctx.ui.select(
				`${fileCount} uncommitted file(s) on ${from}`,
				["Stash and switch", "Switch anyway (carry changes)", "Cancel"],
			);
			if (choice === "Cancel" || choice === undefined) return;
			if (choice === "Stash and switch") {
				const stash = await exec(ctx, "git", [
					"stash", "push", "--include-untracked", "-m", stashMarker(from),
				]);
				if (stash.code !== 0) {
					ctx.ui.notify(`git stash failed: ${stash.stderr.trim()}`, "error");
					return;
				}
				const listed = await listStashes(ctx);
				stashedRef = findStashFor(listed, from)?.ref ?? "stash@{0}";
			}
		}

		const switched = await exec(ctx, "git", ["switch", target]);
		if (switched.code !== 0) {
			const detail = switched.stderr.trim() || `exit ${switched.code}`;
			ctx.ui.notify(
				stashedRef
					? `git switch ${target} failed (${detail}); your changes remain in ${stashedRef}`
					: `git switch ${target} failed (${detail})`,
				"error",
			);
			return;
		}
		emitBranchChange(); // let PR/issue status extensions refresh immediately
		if (stashedRef) {
			ctx.ui.notify(`Stashed ${from} changes as ${stashedRef} · switched to ${target}`, "info");
		}

		// Returning to a branch we previously stashed on → offer to pop exactly that stash
		const stashes = await listStashes(ctx);
		const previous = findStashFor(stashes, target);
		if (previous) {
			const pop = await ctx.ui.confirm(
				`Restore stashed changes on ${target}?`,
				`${previous.ref}: ${previous.message}`,
			);
			if (pop) {
				const popped = await exec(ctx, "git", ["stash", "pop", previous.ref]);
				if (popped.code === 0) {
					ctx.ui.notify(`Popped ${previous.ref} on ${target}`, "info");
				} else {
					ctx.ui.notify(
						`git stash pop ${previous.ref} failed: ${popped.stderr.trim() || popped.stdout.trim()}`,
						"error",
					);
				}
			}
		}

		await refresh(ctx, true);
	};

	const openPicker = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/stack requires Pi's interactive TUI", "warning");
			return;
		}
		const [view, stashes] = await Promise.all([getStackView(ctx), listStashes(ctx)]);
		if (!view) {
			ctx.ui.notify("Current branch is not part of a gh stack", "info");
			return;
		}
		const target = await pickStackBranch(ctx, view, stashes);
		if (!target) return;
		if (target === view.currentBranch) {
			ctx.ui.notify(`Already on ${target}`, "info");
			return;
		}
		await switchToBranch(ctx, view.currentBranch, target);
	};

	pi.registerCommand("stack", {
		description: `Show the current gh stack and switch between its branches (also ${PICKER_SHORTCUT})`,
		handler: async (_args, ctx) => openPicker(ctx),
	});

	pi.registerShortcut(PICKER_SHORTCUT, {
		description: "Open the gh stack branch picker",
		handler: async (ctx) => openPicker(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await refresh(ctx, true);
		timer = setInterval(() => void refresh(ctx), BRANCH_POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx.ui.setStatus(STATUS_ID, undefined);
	});
}
