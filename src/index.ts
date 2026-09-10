import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { credentialRef, type CredentialProvider } from "@deepseek-ai/dsh-credentials";
import {
  LlmAdapter,
  attributionHeaders,
  LlmError,
  CallId,
  ProviderRequestId,
  OFFLOADED_IMAGE_TEXT,
  isQuotaExceededError,
  isContextWindowExceededError,
  QUOTA_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
  type ContentBlock,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
} from "@deepseek-ai/dsh-llm";

export const name = "dsh-zen-spoof";
export const inject = ["llm", "credentials"];

// ─── 常量 ───────────────────────────────────────────────────────────────────────

const ZEN_BASE = "https://opencode.ai/zen/v1";
const FALLBACK_MODELS = [
  "mimo-v2.5-free",
  "deepseek-v4-flash-free",
  "ling-3.0-flash-free",
  "nemotron-3-ultra-free",
];
const RETRYABLE = new Set(["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", EMPTY_RESPONSE_CODE]);

// ─── 配置 ───────────────────────────────────────────────────────────────────────

export interface Config {
  apiKey: string;
  apiKeyRef: string;
  baseURL: string;
  providers: string[];
  spoofClient: string;
  project: string;
  userAgent: string;
  enableAutoFallback: boolean;
  maxFallbackAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().default("").description("显式 Key；为空时从凭据库读取"),
  apiKeyRef: Schema.string().default("OPENCODE_API_KEY").description("凭据库引用名"),
  baseURL: Schema.string().default(ZEN_BASE).description("Zen 网关地址"),
  providers: Schema.array(Schema.string()).default(["opencode"]).description("注册的 provider"),
  spoofClient: Schema.string().default("cli").description("x-opencode-client"),
  project: Schema.string().default("dsh").description("x-opencode-project"),
  userAgent: Schema.string().default("opencode/1.18.30").description("User-Agent"),
  enableAutoFallback: Schema.boolean().default(true).description("429 时自动换模型"),
  maxFallbackAttempts: Schema.number().default(5).description("最多换几个模型"),
  initialBackoffMs: Schema.number().default(1000).description("初始退避"),
  maxBackoffMs: Schema.number().default(30000).description("最大退避"),
  timeoutMs: Schema.number().default(120000).description("空闲超时 ms"),
});

// ─── 工具函数 ───────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function randomHex(len: number): string {
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(len));
  return bytes
    ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    : Array.from({ length: len }, () => Math.random().toString(16).slice(2, 4)).join("");
}

function readSignal(opts: GenerateOptions): AbortSignal | undefined {
  const s = opts.signal;
  if (s instanceof AbortSignal) return s;
  if (isRecord(s) && typeof s["aborted"] === "boolean" && typeof s["addEventListener"] === "function") {
    return s as AbortSignal;
  }
  return undefined;
}

function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return 0;
  const n = Number(raw.trim());
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(raw);
  return Number.isNaN(d) ? 0 : Math.max(0, d - Date.now());
}

function requestId(res: Response): string | undefined {
  for (const k of ["x-request-id", "request-id"]) {
    const v = res.headers.get(k);
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function errorDetail(body: string): string {
  try {
    const j: unknown = JSON.parse(body);
    if (isRecord(j)) {
      const e = isRecord(j["error"]) ? j["error"] : j;
      return [e["code"], e["type"], e["message"]]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .join(" ");
    }
  } catch { /* non-JSON */ }
  return body;
}

// ─── 模型自动发现 ───────────────────────────────────────────────────────────────

async function discoverFreeModels(baseURL: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseURL}/models`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [...FALLBACK_MODELS];
    const body = await res.json();
    if (!isRecord(body) || !Array.isArray(body["data"])) return [...FALLBACK_MODELS];
    const free = (body["data"] as unknown[])
      .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m["id"] === "string")
      .map((m) => m["id"] as string)
      .filter((id) => id.includes("free"))
      .sort();
    return free.length > 0 ? free : [...FALLBACK_MODELS];
  } catch {
    return [...FALLBACK_MODELS];
  }
}

// ─── 消息转换：harness → OpenAI ────────────────────────────────────────────────

function renderText(blocks: readonly ContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push(b.text);
    else if (b.type === "image") out.push(OFFLOADED_IMAGE_TEXT);
    else if (b.type === "tool-result") {
      const inner = renderText(b.content);
      if (inner) out.push(inner);
    }
  }
  return out.join("\n");
}

function toMessages(opts: GenerateOptions) {
  const msgs: Array<Record<string, unknown>> = [];
  if (opts.system && !opts.messages.some((m) => m.role === "system")) {
    msgs.push({ role: "system", content: opts.system });
  }
  for (const entry of opts.messages) {
    if (entry.source.kind === "tool") {
      const first = entry.content[0];
      const text = renderText(entry.content);
      if (first?.type === "tool-result" && first.toolCallId) {
        msgs.push({ role: "tool", content: text, tool_call_id: first.toolCallId });
      } else if (text) {
        msgs.push({ role: "user", content: text });
      }
      continue;
    }
    if (entry.role === "assistant") {
      const texts: string[] = [];
      const calls: Array<Record<string, unknown>> = [];
      for (const b of entry.content) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool-call") {
          calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments } });
        }
      }
      const msg: Record<string, unknown> = { role: "assistant", content: texts.join("\n") };
      if (calls.length) msg["tool_calls"] = calls;
      msgs.push(msg);
      continue;
    }
    msgs.push({ role: entry.role, content: renderText(entry.content) });
  }
  return msgs;
}

function buildBody(opts: GenerateOptions, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: toMessages(opts), stream: true };
  if (opts.temperature !== undefined) body["temperature"] = opts.temperature;
  if (opts.maxTokens !== undefined) body["max_tokens"] = Math.max(1, Math.floor(opts.maxTokens));
  if (opts.stop !== undefined) body["stop"] = opts.stop;
  // 透传 reasoningEffort 给 Zen API，启用思考模式
  if (opts.reasoningEffort !== undefined) body["reasoning_effort"] = opts.reasoningEffort;
  if (opts.tools?.length) {
    body["tools"] = opts.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

// ─── SSE 解析 ───────────────────────────────────────────────────────────────────

interface ParseState {
  opened: Set<number>;
  announced: Set<number>;
  textBuf: Map<number, string>;
  toolId: Map<number, string>;
  toolName: Map<number, string>;
  toolArgs: Map<number, string>;
  usage: { inputTokens: number; outputTokens: number } | undefined;
  finishKind: "stop" | "tool-calls";
  /** reasoning index (固定为 -1，与 text/tool 分开) */
  reasoningIdx: number;
  reasoningBuf: string;
  reasoningOpened: boolean;
}

function extractUsage(d: Record<string, unknown>) {
  const u = d["usage"];
  if (!isRecord(u)) return undefined;
  const pick2 = (keys: string[]) => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
    }
    return 0;
  };
  return { inputTokens: pick2(["prompt_tokens", "input_tokens"]), outputTokens: pick2(["completion_tokens", "output_tokens"]) };
}

function* handleEvent(state: ParseState, payload: string): Generator<StreamChunk> {
  if (!payload || payload === "[DONE]") return;
  let data: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(payload);
    if (!isRecord(p)) return;
    data = p;
  } catch { return; }

  const usage = extractUsage(data);
  if (usage) state.usage = usage;

  const choices = data["choices"];
  if (!Array.isArray(choices) || !choices.length) return;
  const first = choices[0];
  if (!isRecord(first)) return;
  if (pick(first, "finish_reason") === "tool_calls") state.finishKind = "tool-calls";

  const delta = first["delta"] ?? first["message"];
  if (!isRecord(delta)) return;

  // text
  const textParts: string[] = [];
  const dc = (delta as Record<string, unknown>)["content"];
  if (typeof dc === "string" && dc) textParts.push(dc);
  else if (Array.isArray(dc)) {
    for (const p of dc) {
      if (isRecord(p) && p["type"] === "text" && typeof p["text"] === "string") textParts.push(p["text"]);
      else if (isRecord(p) && (p["type"] === "image_url" || p["type"] === "image")) textParts.push(OFFLOADED_IMAGE_TEXT);
    }
  }
  if (typeof delta["refusal"] === "string" && delta["refusal"]) textParts.push(delta["refusal"] as string);

  for (const piece of textParts) {
    if (!state.opened.has(0)) { state.opened.add(0); yield { type: "block-start", index: 0, blockType: "text" }; }
    state.textBuf.set(0, (state.textBuf.get(0) ?? "") + piece);
    yield { type: "text-delta", index: 0, text: piece };
  }

  // reasoning / thinking（Zen 网关通过 reasoning_content 字段返回思考过程）
  const reasoningText = delta["reasoning_content"];
  if (typeof reasoningText === "string" && reasoningText) {
    if (!state.reasoningOpened) {
      state.reasoningOpened = true;
      yield { type: "block-start", index: state.reasoningIdx, blockType: "reasoning" };
    }
    state.reasoningBuf += reasoningText;
    yield { type: "reasoning-delta", index: state.reasoningIdx, text: reasoningText };
  }

  // tool calls
  const tc = delta["tool_calls"];
  if (Array.isArray(tc)) {
    for (const call of tc) {
      if (!isRecord(call)) continue;
      const idx = 1 + Math.max(0, (call["index"] as number) ?? 0);
      if (!state.opened.has(idx)) { state.opened.add(idx); yield { type: "block-start", index: idx, blockType: "tool-call" }; }
      let changed = false;
      if (typeof call["id"] === "string" && call["id"] && state.toolId.get(idx) !== call["id"]) { state.toolId.set(idx, call["id"] as string); changed = true; }
      const fn = isRecord(call["function"]) ? call["function"] : undefined;
      const nm = fn ? (fn["name"] as string) : undefined;
      if (nm && state.toolName.get(idx) !== nm) { state.toolName.set(idx, nm); changed = true; }
      const args = fn ? (typeof fn["arguments"] === "string" ? fn["arguments"] : undefined) : undefined;
      if (args) {
        state.toolArgs.set(idx, (state.toolArgs.get(idx) ?? "") + args);
        yield { type: "tool-call-delta", index: idx, id: CallId(state.toolId.get(idx) ?? `call-${idx}`), name: state.toolName.get(idx) ?? "tool", argumentsDelta: args };
        state.announced.add(idx);
      } else if (changed && !state.announced.has(idx)) {
        yield { type: "tool-call-delta", index: idx, id: CallId(state.toolId.get(idx) ?? `call-${idx}`), name: state.toolName.get(idx) ?? "tool", argumentsDelta: "" };
        state.announced.add(idx);
      }
    }
  }
}

function* emitNonStream(body: string): Generator<StreamChunk> {
  let data: Record<string, unknown>;
  try { const p: unknown = JSON.parse(body); if (!isRecord(p)) throw 0; data = p; } catch { throw new LlmError(`Zen 非流式响应无法解析: ${body.slice(0, 200)}`, "SERVER"); }
  const choices = data["choices"];
  const first = Array.isArray(choices) && choices.length && isRecord(choices[0]) ? choices[0] : undefined;
  const msg = first && isRecord(first["message"]) ? first["message"] : undefined;
  const finish = first ? pick(first, "finish_reason") : undefined;

  // reasoning / thinking（非流式：message.reasoning_content）
  const reasoningText = msg ? (msg["reasoning_content"] as string | undefined) : undefined;
  if (typeof reasoningText === "string" && reasoningText) {
    yield { type: "block-start", index: -1, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: -1, text: reasoningText };
    yield { type: "block-end", index: -1, block: { type: "reasoning", text: reasoningText } };
  }

  const textParts: string[] = [];
  const content = msg ? msg["content"] : undefined;
  if (typeof content === "string" && content) textParts.push(content);
  else if (Array.isArray(content)) {
    for (const p of content) {
      if (isRecord(p) && p["type"] === "text" && typeof p["text"] === "string") textParts.push(p["text"]);
    }
  }
  const refusal = msg ? pick(msg, "refusal") : undefined;
  if (refusal) textParts.push(refusal);
  if (textParts.length) {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: textParts.join("\n") };
    yield { type: "block-end", index: 0, block: { type: "text", text: textParts.join("\n") } };
  }

  const rawCalls = msg ? msg["tool_calls"] : undefined;
  let toolCount = 0;
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call["function"]) ? call["function"] : undefined;
      const idx = 1 + toolCount;
      const id = pick(call, "id") ?? `call-${idx}`;
      const nm = fn ? (pick(fn, "name") ?? "tool") : "tool";
      const args = fn ? (typeof fn["arguments"] === "string" ? fn["arguments"] : "{}") : "{}";
      yield { type: "block-start", index: idx, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: idx, id: CallId(id), name: nm, argumentsDelta: args };
      yield { type: "block-end", index: idx, block: { type: "tool-call", id: CallId(id), name: nm, arguments: args } };
      toolCount++;
    }
  }

  if (!toolCount && !textParts.length) throw new LlmError("Zen 返回了空响应", EMPTY_RESPONSE_CODE);
  const usage = extractUsage(data);
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: finish === "tool_calls" || toolCount > 0 ? "tool-calls" : "stop" } };
}

async function* parseSSE(res: Response, onChunk?: () => void): AsyncGenerator<StreamChunk> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream") && !ct.includes("stream")) {
    yield* emitNonStream(await res.text());
    return;
  }
  if (!res.body) throw new LlmError("Zen 返回了空响应体", EMPTY_RESPONSE_CODE);

  const state: ParseState = {
    opened: new Set(), announced: new Set(),
    textBuf: new Map(), toolId: new Map(), toolName: new Map(), toolArgs: new Map(),
    usage: undefined, finishKind: "stop",
    reasoningIdx: -1, reasoningBuf: "", reasoningOpened: false,
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  const flush = function* (): Generator<StreamChunk> {
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const ev = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of ev.split("\n")) {
        const trimmed = line.trim().replace(/^\uFEFF/, "");
        if (trimmed.startsWith("data:")) yield* handleEvent(state, trimmed.slice(5).trim());
      }
      idx = buf.indexOf("\n\n");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      onChunk?.();
      yield* flush();
    }
  } finally {
    reader.releaseLock();
  }
  buf += dec.decode();
  yield* flush();
  const tail = buf.trim().replace(/^\uFEFF/, "");
  if (tail.startsWith("data:")) yield* handleEvent(state, tail.slice(5).trim());

  // 先关闭 reasoning block（在 text/tool 之前，顺序与 pi-ai 对齐）
  if (state.reasoningOpened) {
    yield { type: "block-end", index: state.reasoningIdx, block: { type: "reasoning", text: state.reasoningBuf } };
  }
  for (const i of [...state.opened].sort((a, b) => a - b)) {
    if (i === 0) {
      yield { type: "block-end", index: i, block: { type: "text", text: state.textBuf.get(i) ?? "" } };
    } else {
      yield { type: "block-end", index: i, block: { type: "tool-call", id: CallId(state.toolId.get(i) ?? `call-${i}`), name: state.toolName.get(i) ?? "tool", arguments: state.toolArgs.get(i) ?? "{}" } };
    }
  }
  if (!state.opened.size) throw new LlmError("Zen 返回了空响应", EMPTY_RESPONSE_CODE);
  const kind = state.finishKind === "tool-calls" || state.toolId.size > 0 ? "tool-calls" : "stop";
  if (state.usage) yield { type: "usage", usage: state.usage };
  yield { type: "finish", reason: { kind } };
}

// ─── 适配器 ─────────────────────────────────────────────────────────────────────

/** 函数级 session 静态变量：同一次对话内复用，跨对话重新生成（与 pi-ai 对齐） */
let sharedSession: string | undefined;

class ZenAdapter extends LlmAdapter {
  private readonly cfg: Config;
  private readonly ctx: Context;
  private models: string[] | undefined;

  constructor(ctx: Context, raw: Config) {
    super();
    this.ctx = ctx;
    this.cfg = {
      ...raw,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
      apiKeyRef: typeof raw.apiKeyRef === "string" && raw.apiKeyRef.trim() ? raw.apiKeyRef.trim() : "OPENCODE_API_KEY",
      userAgent: typeof raw.userAgent === "string" && raw.userAgent.trim() ? raw.userAgent.trim() : "opencode/1.18.30",
      baseURL: (raw.baseURL || ZEN_BASE).replace(/\/+$/, ""),
      maxFallbackAttempts: Math.max(1, Math.min(raw.maxFallbackAttempts ?? 5, 10)),
      initialBackoffMs: Math.max(0, raw.initialBackoffMs ?? 1000),
      maxBackoffMs: Math.max(1, raw.maxBackoffMs ?? 30000),
      timeoutMs: Math.max(0, raw.timeoutMs ?? 120000),
    };
  }

  // ── provider / model ──────────────────────────────────────────────────────

  providerInfo(p: string): LlmProviderInfo { return { id: p, name: "OpenCode Zen" }; }

  private async getModels(): Promise<string[]> {
    if (this.models) return this.models;
    this.models = await discoverFreeModels(this.cfg.baseURL);
    return this.models;
  }

  async listModels(p: string): Promise<readonly LlmModelInfo[]> {
    const list = await this.getModels();
    return list.map((id) => ({ provider: p, id, name: id, inputModalities: ["text"] as const }));
  }

  resolveModel(p: string, model: string): Promise<LlmResolvedModelInfo> {
    // 声明支持 reasoning（避免 harness UNSUPPORTED_REASONING_EFFORT），
    // 实际不传给 Zen 网关——免费模型用默认行为
    return Promise.resolve({
      provider: p, id: model, name: model,
      inputModalities: ["text"] as const,
      reasoning: { efforts: [{ id: ReasoningEffortId("high"), name: "High" }], defaultEffort: ReasoningEffortId("high") },
    });
  }

  // ── 凭据 ──────────────────────────────────────────────────────────────────

  private creds(): CredentialProvider | undefined {
    try {
      const v = (this.ctx as unknown as Record<string, unknown>)["credentials"];
      if (isRecord(v) && typeof v["resolve"] === "function") return v as unknown as CredentialProvider;
    } catch { /* ignore */ }
    return undefined;
  }

  private async resolveKey(): Promise<string> {
    const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim()) ? v.trim() : undefined;
    const fromCfg = clean(this.cfg.apiKey);
    if (fromCfg) return fromCfg;
    const ref = credentialRef(this.cfg.apiKeyRef);
    const provider = this.creds();
    if (provider) {
      const hit = await provider.resolve(ref).catch(() => undefined);
      const val = hit ? clean(hit.value) : undefined;
      if (val) return val;
    }
    const fromEnv = clean(process.env[this.cfg.apiKeyRef]);
    if (fromEnv) return fromEnv;
    throw new LlmError(`缺 Zen Key：请在 dsh 设置里填写，或配置 ${this.cfg.apiKeyRef}`, "AUTH");
  }

  // ── 请求头 ────────────────────────────────────────────────────────────────

  private buildHeaders(): Headers {
    const h = new Headers(attributionHeaders());
    h.set("User-Agent", this.cfg.userAgent);
    h.set("x-opencode-client", this.cfg.spoofClient);
    h.set("x-opencode-project", this.cfg.project);
    sharedSession ??= `ses_${randomHex(12)}`;
    h.set("x-opencode-session", sharedSession);
    h.set("x-opencode-request", `msg_${randomHex(12)}`);
    return h;
  }

  // ── 流式请求 ──────────────────────────────────────────────────────────────

  private async *doStream(model: string, opts: GenerateOptions): AsyncGenerator<StreamChunk> {
    const key = await this.resolveKey();
    const h = this.buildHeaders();
    if (opts.sessionId) h.set("x-opencode-session", String(opts.sessionId));
    h.set("Content-Type", "application/json");
    h.set("Authorization", `Bearer ${key}`);

    const parent = readSignal(opts);
    const ctrl = new AbortController();
    if (parent?.aborted) ctrl.abort();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = this.cfg.timeoutMs > 0
        ? setTimeout(() => { timedOut = true; ctrl.abort(); }, this.cfg.timeoutMs)
        : undefined;
    };
    arm();
    const onAbort = () => ctrl.abort();
    parent?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(`${this.cfg.baseURL}/chat/completions`, {
        method: "POST", headers: h,
        body: JSON.stringify(buildBody(opts, model)),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const detail = errorDetail(body);
        const snippet = (detail || body).slice(0, 300);
        const wait = retryAfterMs(res);
        const rid = requestId(res);
        const facts: Record<string, unknown> = { status: res.status };
        if (wait) facts["providerRetryAfterMs"] = wait;
        if (rid) facts["requestId"] = ProviderRequestId(rid);
        if (res.status === 401 || res.status === 403) throw new LlmError(`Zen 鉴权失败 (${res.status}): ${snippet}`, "AUTH", facts);
        if (/MissingSessionID/i.test(body) || /only be used in OpenCode/i.test(body)) {
          throw new LlmError(`Zen 免费档拒绝 (MissingSessionID): 确认 UA 为 opencode/<版本号>`, "INVALID_REQUEST", facts);
        }
        if (isQuotaExceededError(detail)) throw new LlmError(`Zen 配额耗尽: ${snippet}`, QUOTA_EXCEEDED_CODE, facts);
        if (res.status === 429) throw new LlmError(`Zen 限流 (429): ${snippet}`, "RATE_LIMIT", facts);
        if (res.status === 400) {
          if (isContextWindowExceededError(detail)) throw new LlmError(`Zen 上下文超限: ${snippet}`, CONTEXT_WINDOW_EXCEEDED_CODE, facts);
          throw new LlmError(`Zen 请求错误 (400): ${snippet}`, "INVALID_REQUEST", facts);
        }
        if (res.status === 402) throw new LlmError(`Zen 余额不足 (402): ${snippet}`, QUOTA_EXCEEDED_CODE, facts);
        if (res.status >= 500) throw new LlmError(`Zen 服务端错误 (${res.status}): ${snippet}`, "SERVER", facts);
        throw new LlmError(`Zen 错误 (${res.status}): ${snippet}`, `HTTP_${res.status}`, facts);
      }
      yield* parseSSE(res, arm);
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (ctrl.signal.aborted) {
        if (timedOut) throw new LlmError(`Zen 空闲超时 (${this.cfg.timeoutMs}ms)`, "TIMEOUT", { cause: e });
        throw new LlmError("aborted", "ABORTED", { cause: e });
      }
      throw new LlmError(`Zen 网络错误: ${String(e).slice(0, 200)}`, "TRANSPORT", { cause: e });
    } finally {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  }

  // ── 主入口：带自动轮换 ─────────────────────────────────────────────────────

  async *stream(opts: GenerateOptions): AsyncIterable<StreamChunk> {
    const strip = (id: string) => { const i = id.indexOf("/"); return i >= 0 ? id.slice(i + 1) : id; };
    const first = strip(opts.model);
    const all = await this.getModels();
    const pool = [first, ...all.map(strip).filter((m) => m !== first)];
    const cands = this.cfg.enableAutoFallback ? pool.slice(0, this.cfg.maxFallbackAttempts) : pool.slice(0, 1);

    let lastErr: unknown;
    for (let i = 0; i < cands.length; i++) {
      const model = cands[i];
      let yielded = false;
      try {
        for await (const chunk of this.doStream(model, opts)) { yielded = true; yield chunk; }
        return;
      } catch (e) {
        lastErr = e;
        if (yielded) throw e;
        const code = e instanceof LlmError ? e.failure.code : undefined;
        if (code === "ABORTED") throw e;
        if (!RETRYABLE.has(code ?? "") || i >= cands.length - 1) throw e;
        let wait = 0;
        if (e instanceof LlmError && typeof e.failure.providerRetryAfterMs === "number") wait = e.failure.providerRetryAfterMs;
        const backoff = Math.min(this.cfg.maxBackoffMs, Math.max(this.cfg.initialBackoffMs * 2 ** i + Math.floor(Math.random() * 500), wait));
        console.warn(`[dsh-zen-spoof] ${model} 受限 (${code})，${backoff}ms 后换 ${cands[i + 1]}`);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, backoff);
          readSignal(opts)?.addEventListener("abort", () => { clearTimeout(t); reject(new LlmError("aborted", "ABORTED")); }, { once: true });
        });
      }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError("Zen 全部候选模型均受限", "RATE_LIMIT");
  }
}

// ─── 插件入口 ───────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const adapter = new ZenAdapter(ctx, config);
  ctx.llm.registerAdapter(config.providers ?? ["opencode"], adapter);
}
