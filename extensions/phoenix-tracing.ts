/**
 * Phoenix tracing for pi — high-fidelity OpenInference span emitter.
 *
 * Modeled on Arize's coding-harness-tracing (https://github.com/Arize-ai/coding-harness-tracing),
 * specifically the omp/pi event mapping:
 *
 *   before_agent_start  -> open a trace with a root "Turn" CHAIN span
 *   message_end (asst)  -> LLM span (model, provider, token counts, cost, messages)
 *   tool_execution_*    -> TOOL span with real start/end times
 *   agent_end           -> close root span with final assistant text
 *   session_shutdown    -> fail-safe close + flush
 *
 * Because this runs in-process (unlike the detached-subprocess harness hooks), spans get
 * accurate durations, full llm.input_messages / llm.output_messages, and tool call linkage.
 *
 * Export: Phoenix native REST API (POST {endpoint}/v1/projects/{project}/spans) — the same
 * wire format the Arize repo uses for its Phoenix target. Multiple targets are supported,
 * each with an optional API key.
 *
 * Config (first found wins per key; project file merges over global):
 *   .pi/phoenix-tracing.json          (project-local, only when project is trusted)
 *   ~/.pi/agent/phoenix-tracing.json  (global)
 *
 * {
 *   "enabled": true,
 *   "logPrompts": true,          // false => "__REDACTED__" for prompt/completion values
 *   "logToolContent": true,      // false => redact tool input/output
 *   "emitCosts": false,          // llm.cost.* attrs; off by default so Phoenix
 *                                // (Settings -> Models) owns cost computation
 *   "captureMessages": true,     // llm.input_messages.* / llm.output_messages.* attributes
 *   "captureTools": true,        // llm.tools.*.tool.json_schema (advertised tool definitions)
 *   "maxValueLength": 20000,     // truncation cap for input.value / output.value
 *   "maxMessageLength": 4000,    // truncation cap per captured message
 *   "maxInputMessages": 0,       // keep only the last N llm.input_messages (0 = all)
 *   "targets": [
 *     { "name": "local",  "endpoint": "http://localhost:6006", "project": "pi" },
 *     { "name": "shared", "endpoint": "https://phoenix.corp.example", "project": "team",
 *       "apiKey": "$PHOENIX_API_KEY", "enabled": true }
 *   ]
 * }
 *
 * Target fields:
 *   endpoint  (required) Phoenix base URL
 *   project   (optional) Phoenix project name; defaults to basename(cwd)
 *   apiKey    (optional) literal key, or "$ENV_VAR" to resolve from the environment
 *   name      (optional) label used in /tracing status output
 *   enabled   (optional) default true
 *
 * Zero-config fallback: if no config file exists but PHOENIX_ENDPOINT is set, a single
 * target is created from PHOENIX_ENDPOINT / PHOENIX_API_KEY / PHOENIX_PROJECT.
 *
 * Tracing is fail-soft: exporter errors never interrupt the session (view via /tracing).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TargetConfig {
  name?: string;
  endpoint: string;
  project?: string;
  apiKey?: string;
  enabled?: boolean;
}

interface TracingConfig {
  enabled: boolean;
  logPrompts: boolean;
  logToolContent: boolean;
  captureMessages: boolean;
  captureTools: boolean;
  emitCosts: boolean;
  maxValueLength: number;
  maxMessageLength: number;
  maxInputMessages: number;
  targets: TargetConfig[];
}

const DEFAULTS: TracingConfig = {
  enabled: true,
  logPrompts: true,
  logToolContent: true,
  captureMessages: true,
  captureTools: true,
  emitCosts: false,
  maxValueLength: 20_000,
  maxMessageLength: 4_000,
  maxInputMessages: 0,
  targets: [],
};

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function resolveApiKey(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.startsWith("$")) return process.env[raw.slice(1)] ?? "";
  return raw;
}

function loadConfig(cwd: string, projectTrusted: boolean): TracingConfig {
  const globalCfg = readJson(join(homedir(), ".pi", "agent", "phoenix-tracing.json")) ?? {};
  const projectCfg = projectTrusted
    ? (readJson(join(cwd, CONFIG_DIR_NAME, "phoenix-tracing.json")) ?? {})
    : {};
  const merged = { ...DEFAULTS, ...globalCfg, ...projectCfg } as TracingConfig;

  if (!Array.isArray(merged.targets)) merged.targets = [];
  merged.targets = merged.targets.filter(
    (t) => t && typeof t.endpoint === "string" && t.endpoint.length > 0 && t.enabled !== false,
  );

  // Zero-config fallback via env, mirroring the Arize harness convention.
  if (merged.targets.length === 0 && process.env.PHOENIX_ENDPOINT) {
    merged.targets = [
      {
        name: "env",
        endpoint: process.env.PHOENIX_ENDPOINT,
        project: process.env.PHOENIX_PROJECT || process.env.PHOENIX_PROJECT_NAME || undefined,
        apiKey: process.env.PHOENIX_API_KEY || undefined,
      },
    ];
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Phoenix REST exporter (one queue per target, sequential flush, fail-soft)
// ---------------------------------------------------------------------------

interface PhoenixSpan {
  name: string;
  context: { trace_id: string; span_id: string };
  parent_id?: string;
  span_kind: string;
  start_time: string;
  end_time: string;
  status_code: "OK" | "ERROR" | "UNSET";
  status_message: string;
  attributes: Record<string, unknown>;
}

class PhoenixTarget {
  readonly label: string;
  readonly endpoint: string;
  readonly project: string;
  private readonly apiKey: string;
  private queue: PhoenixSpan[] = [];
  private chain: Promise<void> = Promise.resolve();
  sent = 0;
  failed = 0;
  lastError = "";

  constructor(cfg: TargetConfig, defaultProject: string) {
    this.endpoint = cfg.endpoint.replace(/\/+$/, "");
    this.project = cfg.project || defaultProject;
    this.apiKey = resolveApiKey(cfg.apiKey);
    this.label = cfg.name || this.endpoint;
  }

  enqueue(spans: PhoenixSpan[]): void {
    this.queue.push(...spans);
    this.chain = this.chain.then(() => this.flush()).catch(() => {});
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const url = `${this.endpoint}/v1/projects/${encodeURIComponent(this.project)}/spans`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        this.sent += batch.length;
      } else {
        this.failed += batch.length;
        this.lastError = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      }
    } catch (err) {
      this.failed += batch.length;
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Flush everything before shutdown. Waits for the in-flight chain AND any
   * spans enqueued after the chain was captured (e.g. the Turn root emitted
   * during session_shutdown). The deadline must exceed the 10s fetch timeout,
   * otherwise the final batch — which contains the parent spans — is abandoned
   * mid-request and silently dropped.
   */
  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chain = this.chain;
      await Promise.race([chain, new Promise((r) => setTimeout(r, deadline - Date.now()))]);
      // Settled and nothing new arrived: fully drained.
      if (this.chain === chain && this.queue.length === 0) return;
    }
  }
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

const genTraceId = () => randomBytes(16).toString("hex");
const genSpanId = () => randomBytes(8).toString("hex");
const iso = (ms: number) => new Date(ms).toISOString();

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/** OpenInference standard placeholder for intentionally hidden content. */
const REDACTED = "__REDACTED__";

function redact(allowed: boolean, text: string, max: number): string {
  const value = text ?? "";
  if (!allowed) return REDACTED;
  return truncate(value, max);
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as any).type === "text" && (item as any).text) {
      chunks.push(String((item as any).text));
    }
  }
  return chunks.join("");
}

/**
 * Map pi's api/provider identifiers to the OpenInference `llm.system` well-known
 * values (the AI product, as opposed to `llm.provider`, the host).
 */
function llmSystem(api: string, provider: string, model: string): string {
  const hay = `${api} ${provider} ${model}`.toLowerCase();
  if (hay.includes("anthropic") || hay.includes("claude")) return "anthropic";
  if (hay.includes("openai") || hay.includes("codex") || /\bgpt-/.test(hay)) return "openai";
  if (hay.includes("gemini") || hay.includes("google") || hay.includes("vertex")) return "vertexai";
  if (hay.includes("mistral")) return "mistralai";
  if (hay.includes("cohere")) return "cohere";
  if (hay.includes("xai") || hay.includes("grok")) return "xai";
  if (hay.includes("deepseek")) return "deepseek";
  if (hay.includes("bedrock") || hay.includes("amazon")) return "amazon";
  if (hay.includes("llama") || hay.includes("meta")) return "meta";
  return provider || api || "unknown";
}

// ---------------------------------------------------------------------------
// Tracer state
// ---------------------------------------------------------------------------

interface TraceState {
  traceId: string;
  rootSpanId: string;
  startMs: number;
  prompt: string;
  finalOutput: string;
}

interface PendingTool {
  startMs: number;
  args: Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
  let config: TracingConfig = { ...DEFAULTS };
  let targets: PhoenixTarget[] = [];
  let sessionId = "";
  let trace: TraceState | undefined;
  let contextMessages: Array<{
    role: string;
    content: string;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string; reasoningSignature?: string }>;
    parts?: any[];
  }> = [];

  /**
   * Flatten ordered content parts into `<prefix>.message.contents.*` per the
   * OpenInference multimodal/reasoning conventions. pi content items map as:
   *   text     -> message_content.type="text" (+ .signature from textSignature)
   *   thinking -> message_content.type="reasoning" (+ .signature; redacted blocks
   *               export .data instead of .text, like Anthropic redacted_thinking)
   *   toolCall -> message_content.type="tool_use" with tool_call.* fields
   *               (+ tool_call.reasoning_signature from thoughtSignature)
   * Only emitted when ordering matters: multiple parts or any non-text part.
   */
  function flattenContentParts(
    prefix: string,
    parts: any[],
    attrs: Record<string, unknown>,
  ): void {
    if (!Array.isArray(parts)) return;
    const meaningful = parts.filter((p) => p && typeof p === "object");
    if (meaningful.length <= 1 && meaningful.every((p) => p.type === "text")) return;
    meaningful.forEach((item, j) => {
      const c = `${prefix}.message.contents.${j}.message_content`;
      if (item.type === "text") {
        attrs[`${c}.type`] = "text";
        attrs[`${c}.text`] = redact(
          config.logPrompts,
          String(item.text ?? ""),
          config.maxMessageLength,
        );
        if (item.textSignature) attrs[`${c}.signature`] = String(item.textSignature);
      } else if (item.type === "thinking") {
        attrs[`${c}.type`] = "reasoning";
        if (item.redacted) {
          // Redacted thinking: opaque encrypted payload lives in thinkingSignature.
          if (item.thinkingSignature) attrs[`${c}.data`] = String(item.thinkingSignature);
        } else {
          attrs[`${c}.text`] = redact(
            config.logPrompts,
            String(item.thinking ?? ""),
            config.maxMessageLength,
          );
          if (item.thinkingSignature) attrs[`${c}.signature`] = String(item.thinkingSignature);
        }
      } else if (item.type === "toolCall") {
        attrs[`${c}.type`] = "tool_use";
        const t = `${prefix}.message.contents.${j}.tool_call`;
        attrs[`${t}.id`] = String(item.id ?? "");
        attrs[`${t}.function.name`] = String(item.name ?? "");
        attrs[`${t}.function.arguments`] = redact(
          config.logToolContent,
          JSON.stringify(item.arguments ?? {}),
          config.maxMessageLength,
        );
        if (item.thoughtSignature) attrs[`${t}.reasoning_signature`] = String(item.thoughtSignature);
      }
    });
  }
  let llmStartMs: number | undefined;
  const pendingTools = new Map<string, PendingTool>();
  // Advertised tool definitions, refreshed per agent run: flattened llm.tools.* attrs
  // plus a name -> description index for TOOL spans.
  let toolAttrs: Record<string, string> = {};
  const toolDescriptions = new Map<string, string>();

  function snapshotTools(): void {
    toolAttrs = {};
    toolDescriptions.clear();
    if (!config.captureTools) return;
    try {
      const activeNames = new Set<string>((pi as any).getActiveTools?.() ?? []);
      const all: any[] = (pi as any).getAllTools?.() ?? [];
      let i = 0;
      for (const tool of all) {
        if (!tool?.name) continue;
        toolDescriptions.set(String(tool.name), String(tool.description ?? ""));
        if (activeNames.size > 0 && !activeNames.has(tool.name)) continue;
        toolAttrs[`llm.tools.${i}.tool.json_schema`] = JSON.stringify({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.parameters ?? {},
          },
        });
        i++;
      }
    } catch {
      toolAttrs = {};
    }
  }

  const active = () => config.enabled && targets.length > 0;

  function emit(span: PhoenixSpan): void {
    span.attributes["session.id"] = sessionId;
    if (!span.attributes["metadata"]) span.attributes["metadata"] = JSON.stringify({ harness: "pi" });
    for (const target of targets) target.enqueue([span]);
  }

  function openTrace(prompt: string): void {
    trace = {
      traceId: genTraceId(),
      rootSpanId: genSpanId(),
      startMs: Date.now(),
      prompt,
      finalOutput: "",
    };
  }

  function closeTrace(outputValue: string): void {
    if (!trace) return;
    emit({
      name: "Turn",
      context: { trace_id: trace.traceId, span_id: trace.rootSpanId },
      span_kind: "CHAIN",
      start_time: iso(trace.startMs),
      end_time: iso(Date.now()),
      status_code: "OK",
      status_message: "",
      attributes: {
        "openinference.span.kind": "CHAIN",
        "input.value": redact(config.logPrompts, trace.prompt, config.maxValueLength),
        "input.mime_type": "text/plain",
        "output.value": redact(config.logPrompts, outputValue, config.maxValueLength),
        "output.mime_type": "text/plain",
      },
    });
    trace = undefined;
  }

  function setup(ctx: ExtensionContext): void {
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const defaultProject = ctx.cwd.split("/").filter(Boolean).pop() || "pi";
    targets = config.enabled ? config.targets.map((t) => new PhoenixTarget(t, defaultProject)) : [];
    sessionId = ctx.sessionManager.getSessionId() || `unknown-${process.pid}`;
    trace = undefined;
    pendingTools.clear();
    if (active() && ctx.hasUI) {
      ctx.ui.setStatus("phoenix-tracing", `⌁ phoenix×${targets.length}`);
    }
  }

  // --- Lifecycle -----------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    try {
      setup(ctx);
    } catch {
      /* fail-soft */
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!active()) return;
    try {
      if (trace) closeTrace(trace.finalOutput || "(closed by fail-safe)");
      openTrace(typeof event.prompt === "string" ? event.prompt : "");
      snapshotTools();
    } catch {
      /* fail-soft */
    }
  });

  // Snapshot the exact messages sent to the LLM, for llm.input_messages.*
  pi.on("context", async (event, ctx) => {
    if (!active() || !config.captureMessages) return;
    try {
      // System prompt first, as a system-role message — required for analyzing
      // prompt cache behavior and tool descriptions.
      let systemPrompt = "";
      try {
        systemPrompt = (ctx as any).getSystemPrompt?.() ?? "";
      } catch {
        /* fail-soft */
      }
      const system = systemPrompt
        ? [{ role: "system", content: systemPrompt } as any]
        : [];
      contextMessages = [...system, ...(event.messages ?? [])].map((m: any) => {
        const toolCalls = Array.isArray(m.content)
          ? m.content
              .filter((c: any) => c?.type === "toolCall")
              .map((c: any) => ({
                id: String(c.id ?? ""),
                name: String(c.name ?? ""),
                arguments: JSON.stringify(c.arguments ?? {}),
                reasoningSignature: c.thoughtSignature ? String(c.thoughtSignature) : undefined,
              }))
          : [];
        return {
          role: m.role === "toolResult" ? "tool" : String(m.role ?? "unknown"),
          content: textOfContent(m.content),
          toolCallId: m.role === "toolResult" ? String(m.toolCallId ?? "") : undefined,
          toolName: m.role === "toolResult" ? String(m.toolName ?? "") : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          parts: m.role === "assistant" && Array.isArray(m.content) ? m.content : undefined,
        };
      });
    } catch {
      /* fail-soft */
    }
  });

  pi.on("message_start", async (event) => {
    if (event.message?.role === "assistant") llmStartMs = Date.now();
  });

  // One LLM span per assistant message, with true start/end timestamps.
  pi.on("message_end", async (event) => {
    if (!active() || !trace) return;
    try {
      const message: any = event.message;
      if (message?.role !== "assistant") return;

      const endMs = Date.now();
      const startMs = llmStartMs ?? endMs;
      llmStartMs = undefined;

      const usage = message.usage ?? {};
      const inputTokens = Number(usage.input) || 0;
      const outputTokens = Number(usage.output) || 0;
      const cacheRead = Number(usage.cacheRead) || 0;
      const cacheWrite = Number(usage.cacheWrite) || 0;
      const promptTokens = inputTokens + cacheRead + cacheWrite;
      const reasoning = Number(usage.reasoning) || 0;
      const costBlock = usage.cost ?? {};
      const costInput = Number(costBlock.input) || 0;
      const costOutput = Number(costBlock.output) || 0;
      const costCacheRead = Number(costBlock.cacheRead) || 0;
      const costCacheWrite = Number(costBlock.cacheWrite) || 0;
      const costTotal = Number(costBlock.total) || 0;

      const outputText = textOfContent(message.content);
      const model = String(message.responseModel ?? message.model ?? "");
      const toolCalls = (message.content ?? []).filter((c: any) => c?.type === "toolCall");
      const meta: Record<string, unknown> = { harness: "pi" };
      if (message.responseId) meta.response_id = String(message.responseId);

      const attrs: Record<string, unknown> = {
        "openinference.span.kind": "LLM",
        "llm.model_name": model,
        "llm.provider": String(message.provider ?? ""),
        "llm.system": llmSystem(
          String(message.api ?? ""),
          String(message.provider ?? ""),
          model,
        ),
        "llm.token_count.prompt": promptTokens,
        "llm.token_count.completion": outputTokens,
        "llm.token_count.total": promptTokens + outputTokens,
        "llm.finish_reason": String(message.stopReason ?? ""),
      };

      // input.value: only duplicate the turn prompt here when we are not already
      // exporting the full llm.input_messages.* (avoids per-span payload bloat).
      if (!config.captureMessages) {
        attrs["input.value"] = redact(config.logPrompts, trace.prompt, config.maxValueLength);
        attrs["input.mime_type"] = "text/plain";
      }

      // output.value: assistant text when present; otherwise serialize the tool
      // calls as JSON. Never emit an empty string.
      if (outputText) {
        attrs["output.value"] = redact(config.logPrompts, outputText, config.maxValueLength);
        attrs["output.mime_type"] = "text/plain";
      } else if (toolCalls.length > 0) {
        attrs["output.value"] = redact(
          config.logToolContent,
          JSON.stringify(
            toolCalls.map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} })),
          ),
          config.maxValueLength,
        );
        attrs["output.mime_type"] = "application/json";
      }

      Object.assign(attrs, toolAttrs);
      if (reasoning) attrs["llm.token_count.completion_details.reasoning"] = reasoning;
      if (cacheRead) attrs["llm.token_count.prompt_details.cache_read"] = cacheRead;
      if (cacheWrite) attrs["llm.token_count.prompt_details.cache_write"] = cacheWrite;
      if (config.emitCosts && costTotal) {
        attrs["llm.cost.total"] = costTotal;
        attrs["llm.cost.prompt"] = costInput + costCacheRead + costCacheWrite;
        attrs["llm.cost.completion"] = costOutput;
        if (costInput) attrs["llm.cost.prompt_details.input"] = costInput;
        if (costCacheRead) attrs["llm.cost.prompt_details.cache_read"] = costCacheRead;
        if (costCacheWrite) attrs["llm.cost.prompt_details.cache_write"] = costCacheWrite;
      }

      // High-fidelity OpenInference message attributes.
      if (config.captureMessages) {
        const kept =
          config.maxInputMessages > 0
            ? contextMessages.slice(-config.maxInputMessages)
            : contextMessages;
        kept.forEach((m, i) => {
          attrs[`llm.input_messages.${i}.message.role`] = m.role;
          // Omit empty content (e.g. tool-call-only assistant turns) rather than
          // exporting "" — the tool_calls attributes below carry the payload.
          if (m.content) {
            attrs[`llm.input_messages.${i}.message.content`] = redact(
              config.logPrompts,
              m.content,
              // System prompts get the larger budget: cache and tool-description
              // analysis needs the full prompt, not a 4KB prefix.
              m.role === "system" ? config.maxValueLength : config.maxMessageLength,
            );
          }
          if (m.toolCallId) attrs[`llm.input_messages.${i}.message.tool_call_id`] = m.toolCallId;
          if (m.toolName) attrs[`llm.input_messages.${i}.message.name`] = m.toolName;
          for (const [j, call] of (m.toolCalls ?? []).entries()) {
            const prefix = `llm.input_messages.${i}.message.tool_calls.${j}.tool_call`;
            attrs[`${prefix}.id`] = call.id;
            attrs[`${prefix}.function.name`] = call.name;
            attrs[`${prefix}.function.arguments`] = redact(
              config.logToolContent,
              call.arguments,
              config.maxMessageLength,
            );
            if (call.reasoningSignature) {
              attrs[`${prefix}.reasoning_signature`] = call.reasoningSignature;
            }
          }
          if (m.parts) flattenContentParts(`llm.input_messages.${i}`, m.parts, attrs);
        });
        if (kept.length < contextMessages.length) {
          meta.input_messages_truncated = contextMessages.length - kept.length;
        }
        attrs["llm.output_messages.0.message.role"] = "assistant";
        if (outputText) {
          attrs["llm.output_messages.0.message.content"] = redact(
            config.logPrompts,
            outputText,
            config.maxMessageLength,
          );
        }
        let callIndex = 0;
        for (const item of message.content ?? []) {
          if (item?.type !== "toolCall") continue;
          const prefix = `llm.output_messages.0.message.tool_calls.${callIndex}.tool_call`;
          attrs[`${prefix}.id`] = String(item.id ?? "");
          attrs[`${prefix}.function.name`] = String(item.name ?? "");
          attrs[`${prefix}.function.arguments`] = redact(
            config.logToolContent,
            JSON.stringify(item.arguments ?? {}),
            config.maxMessageLength,
          );
          if (item.thoughtSignature) {
            attrs[`${prefix}.reasoning_signature`] = String(item.thoughtSignature);
          }
          callIndex++;
        }
        // Ordered content parts: reasoning, signatures, and tool_use positioning.
        flattenContentParts("llm.output_messages.0", message.content ?? [], attrs);
      }
      attrs["metadata"] = JSON.stringify(meta);

      const isError = message.stopReason === "error";
      emit({
        name: model ? `LLM: ${model}` : "LLM",
        context: { trace_id: trace.traceId, span_id: genSpanId() },
        parent_id: trace.rootSpanId,
        span_kind: "LLM",
        start_time: iso(startMs),
        end_time: iso(endMs),
        status_code: isError ? "ERROR" : "OK",
        status_message: isError ? String(message.errorMessage ?? "") : "",
        attributes: attrs,
      });
      if (outputText) trace.finalOutput = outputText;
    } catch {
      /* fail-soft */
    }
  });

  // --- TOOL spans with real durations ---------------------------------------

  pi.on("tool_execution_start", async (event) => {
    if (!active()) return;
    pendingTools.set(event.toolCallId, {
      startMs: Date.now(),
      args: (event.args as Record<string, unknown>) ?? {},
    });
  });

  pi.on("tool_execution_end", async (event) => {
    if (!active() || !trace) return;
    try {
      const pending = pendingTools.get(event.toolCallId);
      pendingTools.delete(event.toolCallId);
      const endMs = Date.now();
      const args = pending?.args ?? {};
      const outputText = textOfContent((event.result as any)?.content);
      const isError = Boolean(event.isError);

      const attrs: Record<string, unknown> = {
        "openinference.span.kind": "TOOL",
        "tool.name": event.toolName,
        "tool_call.id": event.toolCallId,
        "tool.id": event.toolCallId,
        "input.value": redact(config.logToolContent, JSON.stringify(args), config.maxValueLength),
        "input.mime_type": "application/json",
        "tool.parameters": redact(
          config.logToolContent,
          JSON.stringify(args),
          config.maxValueLength,
        ),
        "output.value": redact(config.logToolContent, outputText, config.maxValueLength),
        "output.mime_type": "text/plain",
      };
      const description = toolDescriptions.get(event.toolName);
      if (description) attrs["tool.description"] = truncate(description, 1_000);

      emit({
        name: event.toolName,
        context: { trace_id: trace.traceId, span_id: genSpanId() },
        parent_id: trace.rootSpanId,
        span_kind: "TOOL",
        start_time: iso(pending?.startMs ?? endMs),
        end_time: iso(endMs),
        status_code: isError ? "ERROR" : "OK",
        status_message: isError ? redact(config.logToolContent, outputText, 1_000) : "",
        attributes: attrs,
      });
    } catch {
      /* fail-soft */
    }
  });

  // --- Trace close ------------------------------------------------------------

  pi.on("agent_end", async (event) => {
    if (!active() || !trace) return;
    try {
      let finalOutput = "";
      for (const message of [...(event.messages ?? [])].reverse() as any[]) {
        if (message?.role === "assistant") {
          const text = textOfContent(message.content);
          if (text) {
            finalOutput = text;
            break;
          }
        }
      }
      closeTrace(finalOutput || trace.finalOutput);
    } catch {
      /* fail-soft */
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      if (trace) closeTrace(trace.finalOutput || "(closed by session shutdown)");
      await Promise.all(targets.map((t) => t.drain()));
    } catch {
      /* fail-soft */
    }
  });

  // --- Status command ----------------------------------------------------------

  pi.registerCommand("tracing", {
    description: "Show Phoenix tracing status",
    handler: async (_args, ctx) => {
      if (!config.enabled) {
        ctx.ui.notify("Phoenix tracing disabled (see phoenix-tracing.json)", "warning");
        return;
      }
      if (targets.length === 0) {
        ctx.ui.notify(
          "Phoenix tracing: no targets configured (~/.pi/agent/phoenix-tracing.json or PHOENIX_ENDPOINT)",
          "warning",
        );
        return;
      }
      const lines = targets.map((t) => {
        const err = t.lastError ? ` last error: ${t.lastError}` : "";
        return `${t.label} → project "${t.project}" (sent ${t.sent}, failed ${t.failed})${err}`;
      });
      ctx.ui.notify(`Phoenix tracing active\n${lines.join("\n")}`, "info");
    },
  });
}
