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
  type GenerateOptions,
  type StreamChunk,
  type ContentBlock,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
} from "@deepseek-ai/dsh-llm";

export const name = "dsh-zen-spoof";
export const inject = ["llm"];

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface Config {
  apiKey: string;
  apiKeyRef: string;
  baseURL: string;
  providers: string[];
  models: string[];
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
  apiKey: Schema.string()
    .default("")
    .description("显式 Zen Key；为空时自动复用 dsh 凭据库里的存量 Key"),
  apiKeyRef: Schema.string()
    .default("OPENCODE_API_KEY")
    .description("复用的凭据引用名，与 dsh 设置里 opencode 提供方的 apiKeyEnv 保持一致"),
  baseURL: Schema.string()
    .default("https://opencode.ai/zen/v1")
    .description("Zen 网关地址，不要带 /chat/completions 后缀"),
  providers: Schema.array(Schema.string())
    .default(["opencode-zen"])
    .description("注册的 provider 路由名"),
  models: Schema.array(Schema.string())
    .default([
      "big-pickle",
      "mimo-v2.5-free",
      "ling-3.0-flash-fin-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
    ])
    .description("免费模型候选池，用于 429 时轮换"),
  spoofClient: Schema.string().default("tui").description("伪装的 x-opencode-client"),
  project: Schema.string().default("dsh").description("伪装的 x-opencode-project"),
  // 免费档按 UA 白名单放行，必须是 opencode/<版本号> 完整形态（裸 opencode 会吃 MissingSessionID）
  userAgent: Schema.string().default("opencode/1.18.30").description("伪装的 User-Agent"),
  enableAutoFallback: Schema.boolean()
    .default(true)
    .description("429 / 5xx 时是否在候选池内换模型重试"),
  maxFallbackAttempts: Schema.number()
    .default(5)
    .description("单次 stream 最多换几个模型试"),
  initialBackoffMs: Schema.number().default(1000).description("轮换前初始等待"),
  maxBackoffMs: Schema.number().default(30000).description("轮换等待上限"),
  timeoutMs: Schema.number()
    .default(120000)
    .description("空闲超时毫秒数：超过该时长没收到任何分块即超时，0 表示不设超时"),
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof LlmError && typeof error.code === "string") return error.code;
  if (isRecord(error)) return readStringField(error, "code");
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 网关侧 JSON 里偶发把 arguments 写成对象，统一转成可发送的文本。 */
function stringifyArgs(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 空参数统一成 {}，空字符串发给网关可能直接 400。 */
function normalizeArgs(value: unknown, fallback: unknown): string {
  const text = stringifyArgs(value) ?? stringifyArgs(fallback) ?? "{}";
  return text.length > 0 ? text : "{}";
}

function readSignal(options: GenerateOptions): AbortSignal | undefined {
  const maybe = options.signal;
  if (maybe instanceof AbortSignal) return maybe;
  // 跨 realm 或 polyfill 的信号 instanceof 会失效，再按形状认一次
  if (
    isRecord(maybe) &&
    typeof maybe["aborted"] === "boolean" &&
    typeof maybe["addEventListener"] === "function" &&
    typeof maybe["removeEventListener"] === "function"
  ) {
    return maybe as AbortSignal;
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError("aborted", "ABORTED"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmError("aborted", "ABORTED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// harness 消息 -> OpenAI 消息（按 dsh-llm 真实类型转换）
// ---------------------------------------------------------------------------

interface OpenAITextPart {
  type: "text";
  text: string;
}

interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}

type OpenAIPart = OpenAITextPart | OpenAIImagePart;

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIPart[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * harness 内容块渲染成纯文本。图片附件在 harness 里是不透明引用，
 * 适配器拿不到字节，按官方 text-only 序列化策略用占位符保住位置。
 * 推理块是模型内部思维，不回传。
 */
function renderTextBlocks(blocks: readonly ContentBlock[]): string {
  const texts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "reasoning":
        break;
      case "image":
        texts.push(OFFLOADED_IMAGE_TEXT);
        break;
      case "tool-call":
        break;
      case "tool-result": {
        const nested = renderTextBlocks(block.content);
        if (nested.length > 0) texts.push(nested);
        break;
      }
      default:
        break;
    }
  }
  return texts.join("\n");
}

function toOpenAIMessages(options: GenerateOptions): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  if (
    options.system !== undefined &&
    !options.messages.some((entry) => entry.role === "system")
  ) {
    result.push({ role: "system", content: options.system });
  }

  for (const entry of options.messages) {
    // 工具结果：role 为 user、source.kind 为 tool，关联 id 在首块里
    if (entry.source.kind === "tool") {
      const first = entry.content[0];
      const text = renderTextBlocks(entry.content);
      if (first !== undefined && first.type === "tool-result" && first.toolCallId.length > 0) {
        result.push({ role: "tool", content: text, tool_call_id: first.toolCallId });
      } else if (text.length > 0) {
        result.push({ role: "user", content: text });
      }
      continue;
    }

    if (entry.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
      for (const block of entry.content) {
        if (block.type === "text") {
          texts.push(block.text);
        } else if (block.type === "tool-call") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: block.arguments },
          });
        }
      }
      result.push({
        role: "assistant",
        content: texts.join("\n"),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    result.push({ role: entry.role, content: renderTextBlocks(entry.content) });
  }
  return result;
}

/** harness 的生成参数透传给网关，丢了会导致截断位和采样行为对不上。 */
function buildRequestBody(options: GenerateOptions, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(options),
    stream: true,
  };
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  if (options.maxTokens !== undefined) body["max_tokens"] = Math.max(1, Math.floor(options.maxTokens));
  if (options.stop !== undefined) body["stop"] = options.stop;
  if (options.tools !== undefined && options.tools.length > 0) {
    body["tools"] = options.tools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  return body;
}

// ---------------------------------------------------------------------------
// SSE 解析：OpenAI delta -> StreamChunk
// ---------------------------------------------------------------------------

interface OpenAIDelta {
  content?: string;
  refusal?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }>;
}

interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 文本块固定用 0，工具块用 1、2、3……，满足 harness 的 index 从 0 递增要求。 */
const TEXT_INDEX = 0;
const TOOL_INDEX_BASE = 1;

/** 与 harness 默认重试策略对齐的可重试码：耗尽候选后上抛仍可被官方重试接住。 */
const RETRYABLE_CODES = new Set([
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  EMPTY_RESPONSE_CODE,
]);

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (raw === null) return 0;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

function providerRequestId(response: Response): string | undefined {
  for (const key of ["x-request-id", "request-id"]) {
    const value = response.headers.get(key);
    if (value !== null && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** 网关错误体一般是 {error:{code,type,message}}，拼出来喂给官方分类器。 */
function providerDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const err = isRecord(parsed["error"]) ? parsed["error"] : parsed;
      const detail = [err["code"], err["type"], err["message"]]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" ");
      if (detail.length > 0) return detail;
    }
  } catch {
    // 非 JSON 体直接用原文
  }
  return body;
}

/** 照抄官方 deepseek 适配器的状态码映射，保证码制与重试策略一致。 */
async function throwForStatus(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  const detail = providerDetail(body);
  const snippet = (detail.length > 0 ? detail : body).slice(0, 300);
  const wait = retryAfterMs(response);
  const requestId = providerRequestId(response);
  const facts = {
    status: response.status,
    ...(wait > 0 ? { providerRetryAfterMs: wait } : {}),
    ...(requestId !== undefined ? { requestId: ProviderRequestId(requestId) } : {}),
  };
  if (response.status === 401 || response.status === 403) {
    throw new LlmError(`Zen 鉴权失败 (${response.status}): ${snippet}`, "AUTH", facts);
  }
  // 免费档客户端门禁：网关要求真实 OpenCode 客户端，UA 不对或会话不被认可时报此错。
  // 重试无用，直接给可操作信息（换付费模型 ID 或检查 userAgent 配置）。
  if (/MissingSessionID/i.test(body) || /only be used in OpenCode/i.test(body)) {
    throw new LlmError(
      `Zen 免费档拒绝 (MissingSessionID)：网关只认 OpenCode 客户端。请确认 userAgent 为 opencode/<版本号> 完整形态，或改用付费模型 ID: ${snippet}`,
      "INVALID_REQUEST",
      facts,
    );
  }
  if (isQuotaExceededError(detail)) {
    throw new LlmError(`Zen 配额耗尽: ${snippet}`, QUOTA_EXCEEDED_CODE, facts);
  }
  if (response.status === 429) {
    throw new LlmError(`Zen 免费配额受限 (429): ${snippet}`, "RATE_LIMIT", facts);
  }
  if (response.status === 400) {
    if (isContextWindowExceededError(detail)) {
      throw new LlmError(`Zen 上下文超限: ${snippet}`, CONTEXT_WINDOW_EXCEEDED_CODE, facts);
    }
    throw new LlmError(
      `Zen 拒绝请求 (400)，请检查 baseURL 与模型名: ${snippet}`,
      "INVALID_REQUEST",
      facts,
    );
  }
  if (response.status === 402) {
    throw new LlmError(`Zen 余额不足或账单异常 (402): ${snippet}`, QUOTA_EXCEEDED_CODE, facts);
  }
  if (response.status >= 500) {
    throw new LlmError(`Zen 网关错误 (${response.status}): ${snippet}`, "SERVER", facts);
  }
  throw new LlmError(`Zen 网关错误 (${response.status}): ${snippet}`, `HTTP_${response.status}`, facts);
}

function extractUsage(data: Record<string, unknown>): ParsedUsage | undefined {
  const usageRaw = data["usage"];
  if (!isRecord(usageRaw)) return undefined;
  const pick = (keys: string[]): number => {
    for (const key of keys) {
      const value = usageRaw[key];
      if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
    }
    return 0;
  };
  return {
    inputTokens: pick(["prompt_tokens", "input_tokens"]),
    outputTokens: pick(["completion_tokens", "output_tokens"]),
  };
}

function* openBlock(
  opened: Set<number>,
  index: number,
  blockType: "text" | "tool-call",
): Generator<StreamChunk> {
  if (!opened.has(index)) {
    opened.add(index);
    yield { type: "block-start", index, blockType };
  }
}

function* emitTextBlock(text: string): Generator<StreamChunk> {
  if (text.length === 0) return;
  yield { type: "block-start", index: TEXT_INDEX, blockType: "text" };
  yield { type: "text-delta", index: TEXT_INDEX, text };
  yield { type: "block-end", index: TEXT_INDEX, block: { type: "text", text } };
}

/** 网关偶发回包为非流式 JSON（content-type 不是 event-stream），这里做兼容。 */
function* emitNonStreamJson(body: string): Generator<StreamChunk> {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) throw new Error("not an object");
    data = parsed;
  } catch {
    throw new LlmError(`Zen 返回了无法解析的非流式响应: ${body.slice(0, 200)}`, "SERVER");
  }
  const choices = data["choices"];
  const first = Array.isArray(choices) && choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
  const message = first !== undefined && isRecord(first["message"]) ? first["message"] : undefined;
  const finishReason = first !== undefined ? readStringField(first, "finish_reason") : undefined;

  // 文本与拒绝合并成同一个 0 号块，分两次 emit 会出现两个 block-start 0
  const textPieces: string[] = [];
  const content = message !== undefined ? message["content"] : undefined;
  if (typeof content === "string" && content.length > 0) {
    textPieces.push(content);
  } else if (Array.isArray(content)) {
    const joined = wirePartsToText(content);
    if (joined.length > 0) textPieces.push(joined);
  }
  const refusal = message !== undefined ? readStringField(message, "refusal") : undefined;
  if (refusal !== undefined && refusal.length > 0) textPieces.push(refusal);
  if (textPieces.length > 0) yield* emitTextBlock(textPieces.join("\n"));

  const rawCalls = message !== undefined ? message["tool_calls"] : undefined;
  let toolCount = 0;
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call["function"]) ? call["function"] : undefined;
      const index = TOOL_INDEX_BASE + toolCount;
      const id = readStringField(call, "id") ?? `call-${index}`;
      const toolName = (fn !== undefined ? readStringField(fn, "name") : undefined) ?? "tool";
      const args = normalizeArgs(fn !== undefined ? fn["arguments"] : undefined, undefined);
      yield { type: "block-start", index, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index,
        id: CallId(id),
        name: toolName,
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index,
        block: { type: "tool-call", id: CallId(id), name: toolName, arguments: args },
      };
      toolCount += 1;
    }
  }

  if (toolCount === 0 && textPieces.length === 0) {
    throw new LlmError("Zen 返回了空响应", EMPTY_RESPONSE_CODE);
  }
  const usage = extractUsage(data);
  if (usage !== undefined) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: finishReason === "tool_calls" || toolCount > 0 ? "tool-calls" : "stop" } };
}

/** 网关侧 parts 数组（{type:text/image_url}）转文本，图片用占位符。 */
function wirePartsToText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part["type"] === "text") {
      const text = readStringField(part, "text");
      if (text !== undefined) texts.push(text);
    } else if (part["type"] === "image_url" || part["type"] === "image") {
      texts.push(OFFLOADED_IMAGE_TEXT);
    }
  }
  return texts.join("\n");
}

interface ParseState {
  opened: Set<number>;
  announced: Set<number>;
  textBuf: Map<number, string>;
  toolId: Map<number, string>;
  toolName: Map<number, string>;
  toolArgs: Map<number, string>;
  usage: ParsedUsage | undefined;
  finishKind: "stop" | "tool-calls";
}

function* handlePayload(state: ParseState, payload: string): Generator<StreamChunk> {
  if (payload.length === 0 || payload === "[DONE]") return;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return;
    data = parsed;
  } catch {
    return;
  }
  const usage = extractUsage(data);
  if (usage !== undefined) state.usage = usage;

  const choices = data["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return;
  const first = choices[0];
  if (!isRecord(first)) return;
  if (readStringField(first, "finish_reason") === "tool_calls") state.finishKind = "tool-calls";
  // 个别网关在流里塞 message 而不是 delta，做兼容
  const deltaRaw = first["delta"] ?? first["message"];
  if (!isRecord(deltaRaw)) return;
  const typed = deltaRaw as unknown as OpenAIDelta;

  // 文本增量、数组形态 content 与安全拒绝都按文本块下发，避免静默空轮
  const textPieces: string[] = [];
  const deltaContent = (typed as unknown as Record<string, unknown>)["content"];
  if (typeof deltaContent === "string" && deltaContent.length > 0) {
    textPieces.push(deltaContent);
  } else if (Array.isArray(deltaContent)) {
    const joined = wirePartsToText(deltaContent);
    if (joined.length > 0) textPieces.push(joined);
  }
  if (typeof typed.refusal === "string" && typed.refusal.length > 0) textPieces.push(typed.refusal);
  for (const piece of textPieces) {
    yield* openBlock(state.opened, TEXT_INDEX, "text");
    state.textBuf.set(TEXT_INDEX, (state.textBuf.get(TEXT_INDEX) ?? "") + piece);
    yield { type: "text-delta", index: TEXT_INDEX, text: piece };
  }
  if (Array.isArray(typed.tool_calls)) {
    for (const call of typed.tool_calls) {
      // 负数 index 会撞上文本块的 0，钳到 0 以上
      const index = TOOL_INDEX_BASE + Math.max(0, call.index ?? 0);
      yield* openBlock(state.opened, index, "tool-call");
      let headerChanged = false;
      if (typeof call.id === "string" && call.id.length > 0 && state.toolId.get(index) !== call.id) {
        state.toolId.set(index, call.id);
        headerChanged = true;
      }
      const fnName = call.function?.name;
      if (typeof fnName === "string" && fnName.length > 0 && state.toolName.get(index) !== fnName) {
        state.toolName.set(index, fnName);
        headerChanged = true;
      }
      const args = stringifyArgs(call.function?.arguments);
      if (args !== undefined && args.length > 0) {
        state.toolArgs.set(index, (state.toolArgs.get(index) ?? "") + args);
        yield {
          type: "tool-call-delta",
          index,
          id: CallId(state.toolId.get(index) ?? `call-${index}`),
          name: state.toolName.get(index) ?? "tool",
          argumentsDelta: args,
        };
        state.announced.add(index);
      } else if (headerChanged && !state.announced.has(index)) {
        // 首包只有 id + name，先宣告一次，避免下游拿不到调用名
        yield {
          type: "tool-call-delta",
          index,
          id: CallId(state.toolId.get(index) ?? `call-${index}`),
          name: state.toolName.get(index) ?? "tool",
          argumentsDelta: "",
        };
        state.announced.add(index);
      }
    }
  }
}

async function* parseSSE(
  response: Response,
  onProgress?: () => void,
): AsyncGenerator<StreamChunk, void, void> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") && !contentType.includes("stream")) {
    yield* emitNonStreamJson(await response.text());
    return;
  }
  if (response.body === null) {
    throw new LlmError("Zen 返回了空响应体", EMPTY_RESPONSE_CODE);
  }

  const state: ParseState = {
    opened: new Set<number>(),
    announced: new Set<number>(),
    textBuf: new Map<number, string>(),
    toolId: new Map<number, string>(),
    toolName: new Map<number, string>(),
    toolArgs: new Map<number, string>(),
    usage: undefined,
    finishKind: "stop",
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushEvents = function* (): Generator<StreamChunk> {
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim().replace(/^\uFEFF/, "");
        if (trimmed.startsWith("data:")) {
          yield* handlePayload(state, trimmed.slice(5).trim());
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      // done 为 true 时按规范 value 必为空；部分类型声明把 value 标成可选，这里双保险
      if (done || value === undefined) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      onProgress?.();
      yield* flushEvents();
    }
  } finally {
    // 读完或中途退出都释放锁，避免连接残留
    reader.releaseLock();
  }
  buffer += decoder.decode();
  yield* flushEvents();
  // 流结束时若还有残余一行（网关没以空行收尾），别丢掉
  const tail = buffer.trim().replace(/^\uFEFF/, "");
  if (tail.startsWith("data:")) {
    yield* handlePayload(state, tail.slice(5).trim());
  }

  for (const index of [...state.opened].sort((a, b) => a - b)) {
    if (index === TEXT_INDEX) {
      yield {
        type: "block-end",
        index,
        block: { type: "text", text: state.textBuf.get(index) ?? "" },
      };
    } else {
      yield {
        type: "block-end",
        index,
        block: {
          type: "tool-call",
          id: CallId(state.toolId.get(index) ?? `call-${index}`),
          name: state.toolName.get(index) ?? "tool",
          arguments: state.toolArgs.get(index) ?? "{}",
        },
      };
    }
  }
  if (state.opened.size === 0) {
    // 正常结束但零输出块，按官方契约报空响应而不是吐空消息
    throw new LlmError("Zen 返回了空响应", EMPTY_RESPONSE_CODE);
  }
  // 有工具块但网关没给 finish_reason=tool_calls 时，兜底成 tool-calls，保证 Agent 会执行工具
  const kind = state.finishKind === "tool-calls" || state.toolId.size > 0 ? "tool-calls" : "stop";
  if (state.usage !== undefined) yield { type: "usage", usage: state.usage };
  yield { type: "finish", reason: { kind } };
}

// ---------------------------------------------------------------------------
// 适配器本体
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_MODELS = [
  "big-pickle",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
];

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const cleaned = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return cleaned.length > 0 ? cleaned : [...fallback];
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeConfig(raw: Config): Config {
  // 直接 new Adapter 传残缺配置时，Schema 默认值不会生效，这里全部兜底；
  // 显式传空数组属于明确的误配，按 harness 原则大声报错，只有缺字段才回默认值
  if (Array.isArray(raw.providers) && raw.providers.length === 0) {
    throw new LlmError("providers 不能为空，至少保留 opencode-zen", "BAD_CONFIG");
  }
  if (Array.isArray(raw.models) && raw.models.length === 0) {
    throw new LlmError("models 不能为空，至少保留一个免费模型 ID", "BAD_CONFIG");
  }
  const providers = asStringArray(raw.providers, ["opencode-zen"]);
  const models = asStringArray(raw.models, DEFAULT_MODELS);
  const baseURL = (typeof raw.baseURL === "string" ? raw.baseURL : "").replace(/\/+$/, "");
  return {
    ...raw,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    apiKeyRef: typeof raw.apiKeyRef === "string" && raw.apiKeyRef.trim().length > 0
      ? raw.apiKeyRef.trim()
      : "OPENCODE_API_KEY",
    userAgent: typeof raw.userAgent === "string" && raw.userAgent.trim().length > 0
      ? raw.userAgent.trim()
      : "opencode/1.18.30",
    baseURL: baseURL.length > 0 ? baseURL : DEFAULT_BASE_URL,
    providers,
    models,
    maxFallbackAttempts: Math.min(
      Math.max(1, Math.floor(asNumber(raw.maxFallbackAttempts, 5))),
      models.length + 1,
    ),
    initialBackoffMs: Math.max(0, Math.floor(asNumber(raw.initialBackoffMs, 1000))),
    maxBackoffMs:
      asNumber(raw.maxBackoffMs, 30000) > 0 ? Math.floor(asNumber(raw.maxBackoffMs, 30000)) : 30000,
    timeoutMs: Math.max(0, Math.floor(asNumber(raw.timeoutMs, 120000))),
  };
}

class ZenSpoofAdapter extends LlmAdapter {
  private readonly config: Config;
  private readonly sessionId: string;
  private readonly ctx: Context;

  public constructor(ctx: Context, config: Config) {
    super();
    this.ctx = ctx;
    this.config = normalizeConfig(config);
    // session 跨请求复用，request 每次唯一：前者决定免费池的分桶，后者用于追踪
    this.sessionId = `dsh-${Math.random().toString(36).slice(2, 10)}`;
  }

  public override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "OpenCode Zen" };
  }

  public override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      this.config.models.map((id) => ({
        provider,
        id,
        name: id,
        inputModalities: ["text"] as const,
      })),
    );
  }

  public override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ["text"] as const });
  }

  private headers(sessionId: string): Headers {
    const headers = new Headers(attributionHeaders());
    // 下面这组覆盖 harness 默认 UA，是缓解伪 429 的关键
    headers.set("User-Agent", this.config.userAgent);
    headers.set("x-opencode-client", this.config.spoofClient);
    headers.set("x-opencode-project", this.config.project);
    headers.set("x-opencode-session", sessionId);
    headers.set(
      "x-opencode-request",
      `req-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    );
    return headers;
  }

  private credentials(): CredentialProvider | undefined {
    // credentials 服务缺席时回退到环境变量，不让插件整个无法加载
    try {
      const value: unknown = (this.ctx as unknown as Record<string, unknown>)["credentials"];
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>)["resolve"] === "function"
      ) {
        return value as CredentialProvider;
      }
    } catch {
      // 取不到就当不存在
    }
    return undefined;
  }

  /**
   * 取 Key 顺序与官方 pi-ai 一致：显式配置 > dsh 凭据库（逐请求解析，改钥匙不重启）
   * > 进程环境变量。每层都修掉首尾空白（凭据库和 env 常带换行），空值视为缺失继续往下找。
   */
  private async resolveApiKey(): Promise<string> {
    const clean = (value: unknown): string | undefined => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const fromConfig = clean(this.config.apiKey);
    if (fromConfig !== undefined) return fromConfig;
    const ref = credentialRef(this.config.apiKeyRef);
    const provider = this.credentials();
    if (provider !== undefined) {
      const hit = await provider.resolve(ref).catch(() => undefined);
      const fromStore = hit !== undefined ? clean(hit.value) : undefined;
      if (hit !== undefined && fromStore !== undefined) {
        // 只记录来源层级，不记录 Key 本身
        // eslint-disable-next-line no-console
        console.info(`[dsh-zen-spoof] Key 来自凭据库（${hit.source}）`);
        return fromStore;
      }
    }
    const fromEnv = clean(process.env[this.config.apiKeyRef]);
    if (fromEnv !== undefined) return fromEnv;
    throw new LlmError(
      `缺 Zen Key：请在 dsh 设置 → 模型 → opencode 提供方里填写，或配置 ${this.config.apiKeyRef}`,
      "AUTH",
    );
  }

  private async *doStream(model: string, options: GenerateOptions): AsyncGenerator<StreamChunk, void, void> {
    const endpoint = `${this.config.baseURL}/chat/completions`;
    const apiKey = await this.resolveApiKey();
    // 会话分桶优先用 harness 的会话 id，拿不到才用实例随机值
    const headers = this.headers(options.sessionId ?? this.sessionId);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${apiKey}`);

    // 超时与 harness 中止信号二合一：超时走 TIMEOUT（可重试），用户中止走 ABORTED
    const parent = readSignal(options);
    const controller = new AbortController();
    if (parent?.aborted === true) controller.abort();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 空闲口径：收到任何分块即重置，大输出的长尾轮次不会被误杀
    const armTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer =
        this.config.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, this.config.timeoutMs)
          : undefined;
    };
    armTimer();
    const onParentAbort = (): void => controller.abort();
    parent?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(buildRequestBody(options, model)),
        signal: controller.signal,
      });
      if (!response.ok) {
        await throwForStatus(response);
      }
      yield* parseSSE(response, armTimer);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (controller.signal.aborted) {
        if (timedOut) {
          throw new LlmError(`Zen 请求空闲超时 (${this.config.timeoutMs}ms)`, "TIMEOUT", {
            cause: error,
          });
        }
        throw new LlmError("aborted", "ABORTED", { cause: error });
      }
      // fetch 的 TypeError（断网、DNS、网关秒断）按官方口径归为传输错误
      throw new LlmError(`Zen 网络错误: ${errorMessage(error).slice(0, 200)}`, "TRANSPORT", {
        cause: error,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  }

  public async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 选择器有时会带上 provider 前缀（如 opencode-zen/mimo-v2.5-free），网关只认裸 ID
    const stripPrefix = (id: string): string => {
      const slash = id.indexOf("/");
      return slash >= 0 ? id.slice(slash + 1) : id;
    };
    const first = stripPrefix(options.model);
    const pool = [first, ...this.config.models.map(stripPrefix).filter((m) => m !== first)];
    const candidates = this.config.enableAutoFallback
      ? pool.slice(0, this.config.maxFallbackAttempts)
      : pool.slice(0, 1);

    let lastError: unknown;
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const model = candidates[attempt];
      let yielded = false;
      try {
        for await (const chunk of this.doStream(model, options)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (error) {
        lastError = error;
        if (yielded) {
          // 已经吐出过分块，换模型会让同一流里出现重复 index，只能上抛，
          // 由 harness 在 durable 步骤边界重试，保证装配不乱
          throw error;
        }
        const code = errorCode(error);
        if (code === "ABORTED") throw error;
        if (!RETRYABLE_CODES.has(code ?? "") || attempt >= candidates.length - 1) throw error;
        // 等待时间以 failure 事实位为准，外来错误才回退到消息标记兼容
        let serverWait = 0;
        if (error instanceof LlmError && typeof error.failure.providerRetryAfterMs === "number") {
          serverWait = error.failure.providerRetryAfterMs;
        } else {
          const mark = /retry-after-ms=(\d+)/.exec(errorMessage(error))?.[1];
          if (mark !== undefined) serverWait = Number(mark);
        }
        const backoff = Math.min(
          this.config.maxBackoffMs,
          Math.max(
            this.config.initialBackoffMs * 2 ** attempt + Math.floor(Math.random() * 500),
            serverWait,
          ),
        );
        // eslint-disable-next-line no-console
        console.warn(
          `[dsh-zen-spoof] ${model} 受限 (${code})，${backoff}ms 后换 ${candidates[attempt + 1]} 重试`,
        );
        await sleep(backoff, readSignal(options));
      }
    }
    throw lastError instanceof Error ? lastError : new LlmError("Zen 全部候选模型均受限", "RATE_LIMIT");
  }
}

export function apply(ctx: Context, config: Config): void {
  // Key 不在加载时校验：凭据库的值随时可改，逐请求解析，缺 Key 时请求里再报 AUTH
  const normalized = normalizeConfig(config);
  const adapter = new ZenSpoofAdapter(ctx, normalized);
  ctx.llm.registerAdapter(normalized.providers, adapter);
}
