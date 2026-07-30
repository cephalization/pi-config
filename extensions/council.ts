import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyMatch, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

const STATE_TYPE = "council-state";
const MESSAGE_TYPE = "council-message";
const STATUS_ID = "council";
const WIDGET_ID = "council-progress";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDGET_REFRESH_MS = 250;
const CHILD_TIMEOUT_MS = 10 * 60_000;
const ADJOURNED_STATUS_MS = 2_000;
const MAX_RESPONSE_BYTES = 50 * 1024;
const MAX_ERROR_CHARS = 4_000;
const READ_ONLY_TOOLS = "read,grep,find,ls";
const GATED_TOOLS = `${READ_ONLY_TOOLS},bash`;

/**
 * Bash gate loaded into council children. Lives in a subdirectory so the
 * package manifest glob (./extensions/*.ts) never loads it into the parent.
 */
const BASH_GATE_PATH = (() => {
	try {
		return path.join(path.dirname(fileURLToPath(import.meta.url)), "council", "bash-gate.ts");
	} catch {
		return undefined;
	}
})();

function resolveBashGate(): string | undefined {
	return BASH_GATE_PATH && fs.existsSync(BASH_GATE_PATH) ? BASH_GATE_PATH : undefined;
}

const ELDER_NAMES = [
	"Alder",
	"Ash",
	"Briar",
	"Cedar",
	"Cypress",
	"Elm",
	"Hawthorn",
	"Juniper",
	"Laurel",
	"Linden",
	"Maple",
	"Olive",
	"Rowan",
	"Sage",
	"Willow",
	"Yew",
];

const PERSONAS = [
	"the systems architect, who looks for boundaries, invariants, and long-term evolution",
	"the skeptical reviewer, who hunts for hidden assumptions, failure modes, and security risks",
	"the pragmatist, who favors the smallest reliable change and a clear delivery path",
	"the performance sage, who examines scale, latency, resource use, and operational behavior",
	"the maintainer, who prioritizes readability, tests, debugging, and future contributors",
	"the product-minded engineer, who tests whether the solution serves the real user need",
	"the contrarian, who develops the strongest alternative and challenges premature consensus",
	"the reliability elder, who focuses on recovery, observability, rollout, and edge cases",
];

type AnyModel = Model<any>;

type CouncilMember = {
	modelId: string;
	provider: string;
	name: string;
	personality: string;
};

type CouncilState = {
	enabled: boolean;
	members: CouncilMember[];
};

type CouncilMessageDetails =
	| { kind: "question"; text: string; imageCount: number }
	| {
			kind: "response";
			text: string;
			member: CouncilMember;
			usage?: Usage;
			error?: string;
	  }
	| {
			kind: "summary";
			text: string;
			model: string;
			usage?: Usage;
			error?: string;
	  };

type Contribution = { member: CouncilMember; text: string; error?: string };

const CHAIR_SYSTEM_PROMPT = `You are the Chair of a council of independent senior advisers. The user provides the question that was put to the council and each elder's full deliberation.

Synthesize the deliberations into a single brief the user can act on without reading every argument:

1. **Verdict** — the council's bottom line in one or two sentences.
2. **Consensus** — points where the elders substantively agree.
3. **Disputes & rulings** — material disagreements; for each, rule in favor of a side and justify the tie-break in one sentence.
4. **Read further** — which elder(s) to read in full for the most valuable depth, and why.

Aim for under 300 words. Attribute positions to elders by name. Do not invent positions no elder took. If an elder failed to respond, note it briefly.`;

type ChildResult = {
	text: string;
	usage?: Usage;
	error?: string;
};

type MemberProgress = {
	member: CouncilMember;
	state: "pending" | "active" | "done" | "failed";
	startedAt?: number;
	endedAt?: number;
	usage?: Usage;
};

type QueuedQuestion = { text: string; images: ImageContent[] };

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function shuffle<T>(values: readonly T[]): T[] {
	const result = [...values];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function generateMembers(models: AnyModel[]): CouncilMember[] {
	const names = shuffle(ELDER_NAMES);
	const personas = shuffle(PERSONAS);
	return models.map((model, index) => ({
		modelId: model.id,
		provider: model.provider,
		name: `Elder ${names[index % names.length]}${index >= names.length ? ` ${index + 1}` : ""}`,
		personality: personas[index % personas.length],
	}));
}

function modelLabel(member: CouncilMember): string {
	return `${member.provider}/${member.modelId}`;
}

function compactModelId(modelId: string): string {
	return modelId.replace(/^claude-/, "").replace(/^gpt-5\.6-/, "");
}

/** First clause of a persona, e.g. "the systems architect". */
function personaShort(personality: string): string {
	return personality.split(",")[0].trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Compact usage summary, e.g. "↑3.1k ↓845 · $0.0123". */
function formatUsage(usage: Usage): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	return parts.join(" ");
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: Usage, delta: Usage): void {
	total.input += delta.input || 0;
	total.output += delta.output || 0;
	total.cacheRead += delta.cacheRead || 0;
	total.cacheWrite += delta.cacheWrite || 0;
	total.totalTokens = Math.max(total.totalTokens, delta.totalTokens || 0);
	total.cost.input += delta.cost?.input || 0;
	total.cost.output += delta.cost?.output || 0;
	total.cost.cacheRead += delta.cost?.cacheRead || 0;
	total.cost.cacheWrite += delta.cost?.cacheWrite || 0;
	total.cost.total += delta.cost?.total || 0;
}

function searchText(model: AnyModel): string {
	return `${model.provider}/${model.id} ${model.id} ${model.name}`.toLowerCase();
}

function modelMatchScore(query: string, model: AnyModel, preferredProvider?: string): number | undefined {
	const needle = query.toLowerCase();
	const fullId = `${model.provider}/${model.id}`.toLowerCase();
	const id = model.id.toLowerCase();
	let score: number;
	if (needle === fullId) score = 0;
	else if (needle === id) score = 1;
	else if (id.endsWith(`-${needle}`) || id.endsWith(`/${needle}`)) score = 5;
	else if (id.includes(needle)) score = 10 + id.indexOf(needle);
	else {
		const match = fuzzyMatch(needle, searchText(model));
		if (!match.matches) return undefined;
		score = 100 + match.score;
	}
	// Tie-breakers (kept below 1 total so they never jump a score tier):
	// prefer subscription-backed openai-codex over the openai API provider,
	// then the parent session's current provider.
	if (model.provider === "openai-codex") score -= 0.5;
	if (model.provider === preferredProvider) score -= 0.25;
	return score;
}

function resolveModel(query: string, models: AnyModel[], preferredProvider?: string): AnyModel {
	const matches = models
		.map((model) => ({ model, score: modelMatchScore(query, model, preferredProvider) }))
		.filter((item): item is { model: AnyModel; score: number } => item.score !== undefined)
		.sort(
			(a, b) =>
				a.score - b.score ||
				`${a.model.provider}/${a.model.id}`.localeCompare(`${b.model.provider}/${b.model.id}`),
		);
	if (!matches[0]) throw new Error(`No available model matches “${query}”`);
	return matches[0].model;
}

function restoreState(ctx: ExtensionContext): CouncilState {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === STATE_TYPE) {
			const data = entry.data as CouncilState | undefined;
			if (data && typeof data.enabled === "boolean" && Array.isArray(data.members)) return data;
		}
	}
	return { enabled: false, members: [] };
}

function updateStatus(ctx: ExtensionContext, state: CouncilState): void {
	if (!state.enabled) {
		ctx.ui.setStatus(STATUS_ID, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `⚖ Council · ${state.members.length} elders`));
}

function contextMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function imageExtension(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/gif") return "gif";
	if (mimeType === "image/webp") return "webp";
	return "png";
}

function truncateResponse(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_RESPONSE_BYTES) return value;
	let end = Math.min(value.length, MAX_RESPONSE_BYTES);
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > MAX_RESPONSE_BYTES) end--;
	return `${value.slice(0, end)}\n\n[Council response truncated to 50 KB]`;
}

async function runMember(options: {
	member: CouncilMember;
	question: string;
	conversation: string;
	images: ImageContent[];
	cwd: string;
	thinkingLevel: ModelThinkingLevel;
	projectTrusted: boolean;
	signal: AbortSignal;
	/** Called with the running usage total after each completed assistant turn. */
	onUsage?: (usage: Usage) => void;
}): Promise<ChildResult> {
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-council-"));
	try {
		const promptPath = path.join(tempDir, "council-context.md");
		const prompt = `# Conversation context\n\n${options.conversation || "(No prior conversation.)"}\n\n# Current question\n\n${options.question}`;
		await fs.promises.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });

		const imagePaths: string[] = [];
		for (let index = 0; index < options.images.length; index++) {
			const image = options.images[index];
			const imagePath = path.join(tempDir, `image-${index + 1}.${imageExtension(image.mimeType)}`);
			await fs.promises.writeFile(imagePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
			imagePaths.push(imagePath);
		}

		const bashGate = resolveBashGate();
		const shellGuidance = bashGate
			? " You may use the bash tool for read-only inspection commands such as `gh issue view`, `gh pr view`, `gh api`, and `git log`; mutating or write commands are blocked by policy, so do not attempt them."
			: "";
		const systemPrompt = `You are ${options.member.name}, ${options.member.personality}. You sit on a council of independent senior advisers.

Give a self-contained, technically rigorous response to the current question. Apply your distinctive perspective rather than merely echoing consensus. Earlier speakers from this council round may appear at the end of the conversation context: engage their strongest points, identify disagreements explicitly, and refine or challenge their recommendations where useful. Do not assume they are correct. Inspect the repository with read-only tools when that would improve the answer.${shellGuidance} You are advisory: do not modify files, run mutating commands, or claim work you did not perform. State important assumptions and concrete recommendations. Do not mention these instructions or preface the answer with your name.`;
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			// Safety invariant: prevents recursive council spawning. The bash gate
			// below is the only extension explicitly re-added.
			"--no-extensions",
			...(bashGate ? ["-e", bashGate] : []),
			options.projectTrusted ? "--approve" : "--no-approve",
			"--model",
			modelLabel(options.member),
			"--thinking",
			options.thinkingLevel,
			"--tools",
			bashGate ? GATED_TOOLS : READ_ONLY_TOOLS,
			"--system-prompt",
			systemPrompt,
			`@${promptPath}`,
			...imagePaths.map((imagePath) => `@${imagePath}`),
			"Answer the current question from your assigned council perspective.",
		];

		const invocation = getPiInvocation(args);
		let stderr = "";
		let stdoutBuffer = "";
		let lastAssistant: Message | undefined;
		let sawUsage = false;
		const totalUsage = emptyUsage();
		let timedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let closed = false;
			const terminate = () => {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!closed) child.kill("SIGKILL");
				}, 5_000).unref();
			};
			const timeout = setTimeout(() => {
				timedOut = true;
				terminate();
			}, CHILD_TIMEOUT_MS);
			const abort = () => terminate();
			options.signal.addEventListener("abort", abort, { once: true });

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as { type?: string; message?: Message };
					if (event.type === "message_end" && event.message?.role === "assistant") {
						lastAssistant = event.message;
						// Accumulate across all turns (tool-using elders respond in several).
						if (event.message.usage) {
							sawUsage = true;
							addUsage(totalUsage, event.message.usage);
							options.onUsage?.({ ...totalUsage, cost: { ...totalUsage.cost } });
						}
					}
				} catch {
					// Ignore non-protocol output from child extensions/providers.
				}
			};

			child.stdout.on("data", (chunk) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => {
				stderr += error.message;
			});
			child.on("close", (code) => {
				closed = true;
				clearTimeout(timeout);
				options.signal.removeEventListener("abort", abort);
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 1);
			});
		});

		if (options.signal.aborted) return { text: "Consultation cancelled.", error: "cancelled" };
		if (timedOut) return { text: "Consultation timed out.", error: "timed out" };
		if (!lastAssistant || lastAssistant.role !== "assistant") {
			const error = (stderr.trim() || `Council process exited with code ${exitCode}`).slice(0, MAX_ERROR_CHARS);
			return { text: `Unable to respond: ${error}`, error };
		}
		const text = lastAssistant.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		const error = lastAssistant.stopReason === "error" ? lastAssistant.errorMessage || "model error" : undefined;
		return {
			text: truncateResponse(text || (error ? `Unable to respond: ${error}` : "(No textual response.)")),
			usage: sawUsage ? totalUsage : lastAssistant.usage,
			error,
		};
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	}
}

export default function (pi: ExtensionAPI) {
	let state: CouncilState = { enabled: false, members: [] };
	let activeConsultation: AbortController | undefined;
	let statusResetTimer: ReturnType<typeof setTimeout> | undefined;
	let roundProgress: MemberProgress[] | undefined;
	let roundStartedAt = 0;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	const queuedQuestions: QueuedQuestion[] = [];

	const clearStatusReset = () => {
		if (statusResetTimer) clearTimeout(statusResetTimer);
		statusResetTimer = undefined;
	};

	const refreshWidget = (ctx: ExtensionContext) => {
		if (!roundProgress) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const now = Date.now();
		const done = roundProgress.filter((p) => p.state === "done" || p.state === "failed").length;
		const spinner = SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length];
		const queuedNote = queuedQuestions.length
			? theme.fg("warning", `  · ${queuedQuestions.length} question(s) queued for the next round`)
			: "";
		const roundUsage = emptyUsage();
		for (const progress of roundProgress) {
			if (progress.usage) addUsage(roundUsage, progress.usage);
		}
		const costNote = roundUsage.cost.total ? ` · $${roundUsage.cost.total.toFixed(4)}` : "";
		const header =
			theme.fg("accent", `${spinner} ⚖ Council deliberating`) +
			theme.fg("muted", ` · ${done}/${roundProgress.length} · ${formatElapsed(now - roundStartedAt)}${costNote}`) +
			queuedNote;
		const nameWidth = Math.max(...roundProgress.map((p) => p.member.name.length));
		const personaWidth = Math.max(...roundProgress.map((p) => personaShort(p.member.personality).length));
		const lines = [header];
		for (const progress of roundProgress) {
			const name = progress.member.name.padEnd(nameWidth);
			const persona = personaShort(progress.member.personality).padEnd(personaWidth);
			const model = compactModelId(progress.member.modelId);
			switch (progress.state) {
				case "done":
				case "failed": {
					const icon = progress.state === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const took = formatElapsed((progress.endedAt ?? now) - (progress.startedAt ?? now));
					const usageNote = progress.usage ? `  ${formatUsage(progress.usage)}` : "";
					lines.push(
						`  ${icon} ${name}  ${theme.fg("muted", persona)}  ${theme.fg("dim", `${model}  ${took}${usageNote}`)}`,
					);
					break;
				}
				case "active": {
					const usageNote = progress.usage ? `  ${formatUsage(progress.usage)}` : "";
					lines.push(
						`  ${theme.fg("warning", spinner)} ${theme.fg("accent", name)}  ${theme.fg("muted", persona)}  ` +
							theme.fg("muted", `${model}  ${formatElapsed(now - (progress.startedAt ?? now))}${usageNote}`),
					);
					break;
				}
				default:
					lines.push(
						`  ${theme.fg("dim", "○")} ${theme.fg("dim", name)}  ${theme.fg("dim", persona)}  ${theme.fg("dim", model)}`,
					);
			}
		}
		lines.push(theme.fg("dim", "  Messages sent while deliberating are queued for the next council round."));
		ctx.ui.setWidget(WIDGET_ID, lines);
	};

	const startWidget = (ctx: ExtensionContext, members: CouncilMember[]) => {
		roundProgress = members.map((member) => ({ member, state: "pending" }));
		roundStartedAt = Date.now();
		refreshWidget(ctx);
		if (!widgetTimer) widgetTimer = setInterval(() => refreshWidget(ctx), WIDGET_REFRESH_MS);
	};

	const stopWidget = (ctx: ExtensionContext) => {
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		roundProgress = undefined;
		ctx.ui.setWidget(WIDGET_ID, undefined);
	};

	const persistState = (ctx: ExtensionContext) => {
		clearStatusReset();
		pi.appendEntry(STATE_TYPE, state);
		updateStatus(ctx, state);
	};

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as CouncilMessageDetails | undefined;
		if (!details) return new Text(String(message.content), options.outputPad, 0);
		const container = new Container();
		if (details.kind === "question") {
			container.addChild(new Text(theme.fg("accent", theme.bold("Council question")), options.outputPad, 0));
			container.addChild(new Markdown(details.text, options.outputPad, 0, getMarkdownTheme()));
			if (details.imageCount > 0) {
				container.addChild(new Text(theme.fg("dim", `${details.imageCount} image(s) attached`), options.outputPad, 0));
			}
			return container;
		}

		if (details.kind === "summary") {
			const heading = `⚖ Council Chair · ${details.model}`;
			container.addChild(
				new Text(theme.fg(details.error ? "error" : "success", theme.bold(heading)), options.outputPad, 0),
			);
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(details.text, options.outputPad, 0, getMarkdownTheme()));
			if (details.usage) {
				const compact = formatUsage(details.usage);
				if (compact) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", compact), options.outputPad, 0));
				}
			}
			return container;
		}

		const heading = `${details.member.name} · ${modelLabel(details.member)}`;
		container.addChild(new Text(theme.fg(details.error ? "error" : "accent", theme.bold(heading)), options.outputPad, 0));
		container.addChild(new Text(theme.fg("dim", details.member.personality), options.outputPad, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(details.text, options.outputPad, 0, getMarkdownTheme()));
		if (details.usage) {
			const compact = formatUsage(details.usage);
			const expandedExtra = options.expanded
				? ` · W${formatTokens(details.usage.cacheWrite)} · ctx:${formatTokens(details.usage.totalTokens)}`
				: "";
			if (compact || expandedExtra) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `${compact}${expandedExtra}`), options.outputPad, 0));
			}
		}
		return container;
	});

	pi.on("session_start", (_event, ctx) => {
		state = restoreState(ctx);
		updateStatus(ctx, state);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeConsultation?.abort();
		activeConsultation = undefined;
		queuedQuestions.length = 0;
		clearStatusReset();
		stopWidget(ctx);
		ctx.ui.setStatus(STATUS_ID, undefined);
	});

	pi.registerCommand("council", {
		description: "Toggle a randomized council of independent model advisers",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (args === "status") {
				if (!state.members.length) {
					ctx.ui.notify("Council is not configured. Usage: /council <model> <model> …", "info");
					return;
				}
				const roster = state.members
					.map((member) => `  ${member.name} (${modelLabel(member)}) — ${member.personality}`)
					.join("\n");
				ctx.ui.notify(`Council ${state.enabled ? "enabled" : "disabled"}:\n${roster}`, "info");
				return;
			}
			if (args === "off" || (!args && state.enabled)) {
				state = { ...state, enabled: false };
				const wasDeliberating = Boolean(activeConsultation);
				activeConsultation?.abort();
				queuedQuestions.length = 0;
				persistState(ctx);
				ctx.ui.notify(
					wasDeliberating ? "Council mode disabled; stopping the current deliberation" : "Council mode disabled",
					"info",
				);
				return;
			}
			if (args === "on" || !args) {
				if (!state.members.length) {
					ctx.ui.notify("Usage: /council <fuzzy-model> <fuzzy-model> …", "warning");
					return;
				}
				state = { ...state, enabled: true };
				persistState(ctx);
				ctx.ui.notify("Council mode enabled", "info");
				return;
			}

			try {
				await ctx.modelRegistry.refresh();
				const available = ctx.modelRegistry.getAvailable();
				if (!available.length) throw new Error("No authenticated models are available");
				const queries = args.split(/\s+/).filter(Boolean);
				const models = queries.map((query) => resolveModel(query, available, ctx.model?.provider));
				const ids = models.map((model) => `${model.provider}/${model.id}`);
				if (new Set(ids).size !== ids.length) throw new Error("Two arguments resolved to the same model");
				state = { enabled: true, members: generateMembers(models) };
				persistState(ctx);
				ctx.ui.notify(`Council enabled: ${ids.join(", ")}`, "info");
			} catch (error) {
				ctx.ui.notify(`/council: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	const runRound = async (
		ctx: ExtensionContext,
		question: string,
		images: ImageContent[],
		controller: AbortController,
	): Promise<void> => {
		const baseline = contextMessages(ctx);
		let conversation = serializeConversation(convertToLlm(baseline));
		const questionContent: Array<{ type: "text"; text: string } | ImageContent> = [
			{ type: "text", text: `<council_question>\n${question}\n</council_question>` },
			...images,
		];
		pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: questionContent,
			display: true,
			details: { kind: "question", text: question, imageCount: images.length } satisfies CouncilMessageDetails,
		});

		const order = shuffle(state.members);
		const contributions: Contribution[] = [];
		startWidget(ctx, order);
		for (let index = 0; index < order.length; index++) {
			const member = order[index];
			const progress = roundProgress?.[index];
			if (progress) {
				progress.state = "active";
				progress.startedAt = Date.now();
			}
			refreshWidget(ctx);
			ctx.ui.setStatus(
				STATUS_ID,
				ctx.ui.theme.fg(
					"warning",
					`⚖ Council ${index + 1}/${order.length} · ${member.name} · ${compactModelId(member.modelId)}`,
				),
			);
			const model = ctx.modelRegistry.find(member.provider, member.modelId);
			const supportedImages = model?.input.includes("image") ? images : [];
			let result: ChildResult;
			try {
				result = await runMember({
					member,
					question,
					conversation,
					images: supportedImages,
					cwd: ctx.cwd,
					thinkingLevel: ctx.thinkingLevel,
					projectTrusted: ctx.isProjectTrusted(),
					signal: controller.signal,
					onUsage: (usage) => {
						if (progress) progress.usage = usage;
					},
				});
			} catch (error) {
				const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);
				result = { text: `Unable to respond: ${message}`, error: message };
			}
			if (progress) {
				progress.state = result.error ? "failed" : "done";
				progress.endedAt = Date.now();
				progress.usage = result.usage;
			}
			refreshWidget(ctx);
			if (controller.signal.aborted) break;
			contributions.push({ member, text: result.text, error: result.error });
			if (!result.error) {
				conversation += `\n\n--- Earlier council contribution: ${member.name} (${modelLabel(member)}) ---\n${result.text}`;
			}
			pi.sendMessage({
				customType: MESSAGE_TYPE,
				content: `<council_response elder="${member.name}" model="${modelLabel(member)}">\n${result.text}\n</council_response>`,
				display: true,
				details: {
					kind: "response",
					text: result.text,
					member,
					usage: result.usage,
					error: result.error,
				} satisfies CouncilMessageDetails,
			});
			if (controller.signal.aborted) break;
		}
		if (!controller.signal.aborted) {
			await runChair(ctx, question, contributions, controller);
		}
	};

	/** In-process synthesis of the round by the primary session model. */
	const runChair = async (
		ctx: ExtensionContext,
		question: string,
		contributions: Contribution[],
		controller: AbortController,
	): Promise<void> => {
		const successful = contributions.filter((entry) => !entry.error);
		if (successful.length < 2) return; // Nothing to reconcile.
		const chairModel = ctx.model;
		if (!chairModel) {
			ctx.ui.notify("Council chair skipped: no session model selected", "warning");
			return;
		}
		const chairLabel = `${chairModel.provider}/${chairModel.id}`;
		const chairProgress: MemberProgress = {
			member: {
				modelId: chairModel.id,
				provider: chairModel.provider,
				name: "The Chair",
				personality: "presiding, synthesizes the round and rules on disputes",
			},
			state: "active",
			startedAt: Date.now(),
		};
		roundProgress?.push(chairProgress);
		refreshWidget(ctx);
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", `⚖ Council · the Chair is synthesizing · ${compactModelId(chairModel.id)}`));

		let text: string;
		let usage: Usage | undefined;
		let error: string | undefined;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(chairModel);
			if (!auth.ok) throw new Error(auth.error);
			const body = contributions
				.map(
					(entry) =>
						`## ${entry.member.name} (${modelLabel(entry.member)}) — ${entry.member.personality}${entry.error ? " [failed to respond]" : ""}\n\n${entry.text}`,
				)
				.join("\n\n---\n\n");
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: `# Question put to the council\n\n${question}\n\n# Deliberations\n\n${body}` }],
				timestamp: Date.now(),
			};
			const response = await complete(
				chairModel,
				{ systemPrompt: CHAIR_SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: controller.signal, cacheRetention: "none" },
			);
			if (response.stopReason === "aborted") {
				chairProgress.state = "failed";
				chairProgress.endedAt = Date.now();
				return;
			}
			usage = response.usage;
			error = response.stopReason === "error" ? response.errorMessage || "model error" : undefined;
			text =
				response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.trim() || (error ? `Unable to synthesize: ${error}` : "(No synthesis produced.)");
		} catch (chairError) {
			error = (chairError instanceof Error ? chairError.message : String(chairError)).slice(0, MAX_ERROR_CHARS);
			text = `Unable to synthesize: ${error}`;
		}
		chairProgress.state = error ? "failed" : "done";
		chairProgress.endedAt = Date.now();
		chairProgress.usage = usage;
		refreshWidget(ctx);
		pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: `<council_summary chair="${chairLabel}">\n${text}\n</council_summary>`,
			display: true,
			details: { kind: "summary", text, model: chairLabel, usage, error } satisfies CouncilMessageDetails,
		});
	};

	pi.on("input", async (event, ctx) => {
		if (!state.enabled || event.source === "extension") return { action: "continue" };
		if (!event.text.trim() && !event.images?.length) return { action: "continue" };
		const question = event.text.trim() || "Please examine the attached image(s).";
		const images = event.images ?? [];

		if (activeConsultation) {
			queuedQuestions.push({ text: question, images });
			ctx.ui.notify(
				`Queued for the next council round (${queuedQuestions.length} waiting). Use /council off to stop.`,
				"info",
			);
			refreshWidget(ctx);
			return { action: "handled" };
		}

		clearStatusReset();
		activeConsultation = new AbortController();
		const controller = activeConsultation;
		try {
			await runRound(ctx, question, images, controller);
			// Deliver questions submitted mid-round as follow-up council rounds.
			while (queuedQuestions.length && state.enabled && !controller.signal.aborted) {
				const batch = queuedQuestions.splice(0, queuedQuestions.length);
				const combined = batch.map((entry) => entry.text).join("\n\n");
				const combinedImages = batch.flatMap((entry) => entry.images);
				await runRound(ctx, combined, combinedImages, controller);
			}
		} finally {
			if (activeConsultation === controller) activeConsultation = undefined;
			stopWidget(ctx);
			if (state.enabled && !controller.signal.aborted) {
				ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("success", "⚖ Council · adjourned"));
				statusResetTimer = setTimeout(() => {
					statusResetTimer = undefined;
					if (!activeConsultation) updateStatus(ctx, state);
				}, ADJOURNED_STATUS_MS);
			} else {
				updateStatus(ctx, state);
			}
		}
		return { action: "handled" };
	});
}
