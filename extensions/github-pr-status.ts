import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "github-pr";
const BRANCH_POLL_INTERVAL_MS = 2_000;
const PR_REFRESH_INTERVAL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_TITLE_LENGTH = 60;

type PullRequest = {
	isDraft: boolean;
	number: number;
	state: string;
	title: string;
	url: string;
};

function truncateTitle(title: string): string {
	if (title.length <= MAX_TITLE_LENGTH) return title;
	return `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let lastBranch: string | undefined;
	let lastPullRequestCheck = 0;

	const clearStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_ID, undefined);
	};

	const refresh = async (ctx: ExtensionContext, force = false) => {
		if (refreshing) return;
		refreshing = true;

		try {
			const branchResult = await pi.exec("git", ["branch", "--show-current"], {
				cwd: ctx.cwd,
				timeout: COMMAND_TIMEOUT_MS,
			});
			const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";

			if (!branch) {
				lastBranch = undefined;
				lastPullRequestCheck = 0;
				clearStatus(ctx);
				return;
			}

			const branchChanged = branch !== lastBranch;
			const refreshDue = Date.now() - lastPullRequestCheck >= PR_REFRESH_INTERVAL_MS;
			if (!force && !branchChanged && !refreshDue) return;

			lastBranch = branch;
			lastPullRequestCheck = Date.now();
			if (branchChanged) clearStatus(ctx);

			const prResult = await pi.exec(
				"gh",
				["pr", "view", branch, "--json", "number,title,url,state,isDraft"],
				{ cwd: ctx.cwd, timeout: COMMAND_TIMEOUT_MS },
			);

			if (prResult.code !== 0) {
				clearStatus(ctx);
				return;
			}

			const pr = JSON.parse(prResult.stdout) as PullRequest;
			const state = pr.isDraft ? "draft" : pr.state.toLowerCase();
			const theme = ctx.ui.theme;
			const statusText =
				theme.fg("accent", `PR #${pr.number}`) +
				theme.fg("dim", ` · ${truncateTitle(pr.title)} · ${state}`);
			const linkedStatus = `\u001b]8;;${pr.url}\u0007${statusText}\u001b]8;;\u0007`;
			ctx.ui.setStatus(STATUS_ID, linkedStatus);
		} catch {
			clearStatus(ctx);
		} finally {
			refreshing = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		lastBranch = undefined;
		lastPullRequestCheck = 0;
		await refresh(ctx, true);
		timer = setInterval(() => void refresh(ctx), BRANCH_POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		clearStatus(ctx);
	});

	pi.registerCommand("pr-status-refresh", {
		description: "Refresh the pull request shown in the status bar",
		handler: async (_args, ctx) => {
			await refresh(ctx, true);
		},
	});
}
