import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ProviderPayload = Record<string, unknown> & {
	tools?: unknown;
};

function isPayload(value: unknown): value is ProviderPayload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addTool(payload: ProviderPayload, tool: Record<string, unknown>): ProviderPayload {
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (tools.some((candidate) => isPayload(candidate) && candidate.type === tool.type)) {
		return payload;
	}

	return { ...payload, tools: [...tools, tool] };
}

function supportsNativeWebSearch(model: { api: string; provider: string }): boolean {
	if (model.provider === "anthropic") return model.api === "anthropic-messages";
	if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
	return (
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "openai-completions"
	);
}

const WEB_SEARCH_GUIDANCE = `## Web access
Provider-native web search is available and is the default way to access the public web.
- Use native web search for web research, current information, finding sources, and reading or summarizing public webpages.
- Do not invoke agent-browser, another browser CLI, curl, or a client-side search tool for those tasks.
- Use browser automation only when the task requires interaction or browser state, such as clicking, filling forms, authentication, screenshots, visual UI testing, localhost, or an explicitly requested browser workflow.`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.model || !supportsNativeWebSearch(ctx.model)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${WEB_SEARCH_GUIDANCE}` };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || !isPayload(event.payload)) return;

		if (model.provider === "anthropic" && model.api === "anthropic-messages") {
			return addTool(event.payload, {
				type: "web_search_20250305",
				name: "web_search",
			});
		}

		if (model.provider !== "openai" && model.provider !== "openai-codex") return;

		if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
			return addTool(event.payload, {
				type: "web_search",
				search_context_size: "medium",
			});
		}

		// Search-capable Chat Completions models use a top-level option rather
		// than a Responses API hosted-tool declaration.
		if (model.api === "openai-completions" && event.payload.web_search_options === undefined) {
			return {
				...event.payload,
				web_search_options: { search_context_size: "medium" },
			};
		}
	});
}
