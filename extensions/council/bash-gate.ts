/**
 * Council bash gate — loaded ONLY into council child processes via `pi -e`.
 *
 * Council elders are advisory and must stay read-only. This gate enables the
 * bash tool for context-gathering commands (`gh issue view`, `git log`, …)
 * while blocking anything that mutates state, writes to the network, or uses
 * shell control operators.
 *
 * Not matched by the package manifest glob (`./extensions/*.ts`), so it never
 * loads into the parent session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Verdict = { ok: true } | { ok: false; reason: string };

/** Commands allowed after a pipe (pure stream filters). */
const FILTER_COMMANDS = new Set(["head", "tail", "grep", "wc", "sort", "uniq", "cut", "tr", "column", "jq", "cat"]);

/** Read-only git subcommands. */
const GIT_SUBCOMMANDS = new Set([
	"log",
	"show",
	"diff",
	"status",
	"blame",
	"describe",
	"rev-parse",
	"ls-files",
	"ls-remote",
	"grep",
	"shortlog",
	"reflog",
	"cat-file",
	"stash", // further restricted to `stash list` below
]);

/** gh subcommand → allowed second-level subcommands. */
const GH_SUBCOMMANDS: Record<string, Set<string>> = {
	issue: new Set(["view", "list", "status"]),
	pr: new Set(["view", "list", "diff", "checks", "status"]),
	repo: new Set(["view"]),
	run: new Set(["view", "list"]),
	release: new Set(["view", "list"]),
	label: new Set(["list"]),
	workflow: new Set(["view", "list"]),
	search: new Set(["issues", "prs", "repos", "code", "commits"]),
};

/** Flags that turn `gh api` into a write request. */
const GH_API_WRITE_FLAGS = new Set(["-X", "--method", "-F", "--field", "-f", "--raw-field", "--input"]);

function no(reason: string): Verdict {
	return { ok: false, reason: `Council members are read-only advisers: ${reason}` };
}

/** Split a pipe segment into tokens, honoring single/double quotes. */
function tokenize(segment: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let sawQuote = false;
	for (const char of segment) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			sawQuote = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (current || sawQuote) {
				tokens.push(current);
				current = "";
				sawQuote = false;
			}
			continue;
		}
		current += char;
	}
	if (quote) return undefined;
	if (current || sawQuote) tokens.push(current);
	return tokens;
}

function checkGh(args: string[]): Verdict {
	const sub = args[0];
	if (sub === "status") return { ok: true };
	if (sub === "api") {
		for (const arg of args) {
			if (GH_API_WRITE_FLAGS.has(arg) || arg.startsWith("--method=")) {
				return no("gh api is limited to GET requests");
			}
		}
		return { ok: true };
	}
	const allowed = sub ? GH_SUBCOMMANDS[sub] : undefined;
	const sub2 = args[1];
	if (allowed && sub2 && allowed.has(sub2)) return { ok: true };
	return no(`\`gh ${[sub, sub2].filter(Boolean).join(" ")}\` is not on the read-only allowlist`);
}

function checkGit(args: string[]): Verdict {
	const sub = args[0];
	if (sub === "branch") {
		// Listing only: every argument must be a flag (no branch creation/deletion).
		const flagsOnly = args.slice(1).every((arg) => arg.startsWith("-"));
		const mutating = args.some((arg) => ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy"].includes(arg));
		if (flagsOnly && !mutating) return { ok: true };
		return no("`git branch` is limited to listing (flags only)");
	}
	if (sub === "stash") {
		if (args[1] === "list") return { ok: true };
		return no("`git stash` is limited to `git stash list`");
	}
	if (sub && GIT_SUBCOMMANDS.has(sub)) return { ok: true };
	return no(`\`git ${sub ?? ""}\` is not on the read-only allowlist`);
}

export function checkCouncilCommand(command: string): Verdict {
	if (/[;`$<>&\r\n\x00]/.test(command) || command.includes("||")) {
		return no("shell control operators (; ` $ < > & newline) are not allowed");
	}
	const segments = command.split("|");
	for (let index = 0; index < segments.length; index++) {
		const tokens = tokenize(segments[index]);
		if (!tokens) return no("unbalanced quotes");
		// Skip leading environment assignments such as GH_PAGER=cat.
		let start = 0;
		while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start++;
		const executable = tokens[start];
		const args = tokens.slice(start + 1);
		if (!executable) return no("empty command segment");
		if (executable.includes("/")) return no("commands must be bare allowlisted names, not paths");
		if (index > 0) {
			if (!FILTER_COMMANDS.has(executable)) {
				return no(`\`${executable}\` is not an allowed pipe filter`);
			}
			continue;
		}
		let verdict: Verdict;
		if (executable === "gh") verdict = checkGh(args);
		else if (executable === "git") verdict = checkGit(args);
		else if (FILTER_COMMANDS.has(executable)) verdict = { ok: true };
		else verdict = no(`\`${executable}\` is not allowlisted. Allowed: gh (read subcommands), git (read subcommands), ${[...FILTER_COMMANDS].join("/")}`);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const verdict = checkCouncilCommand(command);
		if (!verdict.ok) return { block: true, reason: verdict.reason };
	});
}
