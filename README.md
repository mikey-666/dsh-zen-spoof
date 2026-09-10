# dsh-zen-spoof

给 `DeepSeek Harness` 用的 `OpenCode Zen` 免费模型补丁插件。

解决的是第二种 `429`：`Key` 明明还有额度，但因为 `dsh` 没带 `OpenCode` 官方客户端头，被 `Zen` 按最严档限流。

## 原理

单独注册 `opencode-zen` 路由，直调 `POST /chat/completions`，并在每次请求上强制覆盖：

```text
User-Agent: opencode
x-opencode-client: tui
x-opencode-project: dsh
x-opencode-session: dsh-xxx（插件实例内稳定复用）
x-opencode-request: req-xxx（每次请求唯一）
```

同时保留 `harness` 规范要求的 `attributionHeaders()`，只是让后面的伪装头覆盖 `UA`。

`429` 或网关 `5xx` 时，按指数退避在候选池里换下一个免费模型试一次，次数可配，并优先尊重网关返回的 `Retry-After`。

## 目录结构

```text
dsh-zen-spoof/
  src/index.ts          # 源码
  dist/index.js         # 构建产物（bundle 入口，安装时实际加载它）
  cordis.patch.yml      # bundle 自带配置层（包名引用，随包安装自动生效）
  cordis.yml            # 极简联调配置（--patch 用，指源码）
  cordis.example.yml    # 完整联调配置（--patch 用，指源码）
  package.json          # 含 dsh.bundle 清单
  tsconfig.json
  README.md
  LICENSE
```

## 安装（正式方式，重启不丢）

和插件广场其他插件同一套机制（`bundle → profile`，`dsh plugin add` 安装即自动挂载），
差别只在分发渠道：上架插件用包名／`github:` 地址，我们目前是本地目录，写法等价：

```powershell
# 上架插件的装法（示例）
dsh plugin --profile web add dsh-skin-center
dsh plugin --profile web add github:you/dsh-zen-spoof

# 我们的装法（本地目录，机制相同）
cd C:\Users\20113
& "F:\Program Files\dsh\dsh.cmd" plugin --profile web add ./dsh-zen-spoof
```

完整步骤（本地安装）：

```powershell
# 1. 先构建一次（本地目录安装不会替你跑构建）
cd C:\Users\20113\dsh-zen-spoof
pnpm install
pnpm build

# 2. 装进 web profile（从包含本目录的上级执行，pnpm 会链接并登记 bundle）
cd C:\Users\20113
& "F:\Program Files\dsh\dsh.cmd" plugin --profile web add ./dsh-zen-spoof

# 3. 确认层已登记（应能看到 dsh-zen-spoof 一层），然后正常启动
& "F:\Program Files\dsh\dsh.cmd" --profile web --dump-config
& "F:\Program Files\dsh\dsh.cmd" web
```

`Key` 不用手写环境变量：插件自动复用你在 `dsh` 设置里给 `opencode` 配好的存量 `Key`
（引用名默认 `OPENCODE_API_KEY`，与设置里的 `apiKeyEnv` 一致），改钥匙不重启即生效。
想写死可用 `Key` 就在配置里加 `apiKey` 字段（覆盖配置时须重述全部键）。

改本地代码想实时生效：改完跑 `pnpm build` 再重启即可（`add` 的是链接，直指本目录）。
卸载：`dsh plugin --profile web remove dsh-zen-spoof`，依赖与配置层一起撤掉。

注意：从 `git` 地址安装时 `pnpm` 不跑构建脚本，包里已有 `prepare` 自动补构建，
首次会要求在 `profile` 的 `pnpm-workspace.yaml` 里加 `allowBuilds` 放行，这是官方流程，
只对信任来源放行。

## 试用（临时联调，不想装时用）

```powershell
cd C:\Users\20113\dsh-zen-spoof
& "F:\Program Files\dsh\dsh.cmd" web --patch ./cordis.example.yml
```

`Key` 同样自动复用存量，不用设环境变量。

只想先跑通，用极简版（同样先 `cd` 进目录）：

```powershell
& "F:\Program Files\dsh\dsh.cmd" web --patch ./cordis.yml
```

说明：关键是 `cwd` 要在插件目录（或把 `yml` 里 `name` 改成绝对路径），否则相对路径解析不到 `src/index.ts`。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | 空 | 显式 `Zen Key`，为空时自动复用 `dsh` 凭据库存量 |
| `apiKeyRef` | `OPENCODE_API_KEY` | 复用的凭据引用名，与 `opencode` 提供方的 `apiKeyEnv` 一致 |
| `baseURL` | `https://opencode.ai/zen/v1` | 不要带 `/chat/completions`，末尾斜杠自动归一化 |
| `providers` | `["opencode-zen"]` | 路由名，不要和 `llm-pi-ai` 里的同名配置共存 |
| `models` | `5` 个免费模型 | `429` 轮换池，为空时拒载 |
| `enableAutoFallback` | `true` | 是否自动换模型 |
| `maxFallbackAttempts` | `5` | 单次最多换几个，自动钳位到候选池长度 |
| `initialBackoffMs` | `1000` | 退避起点 |
| `maxBackoffMs` | `30000` | 退避上限，`0` 时按 `30` 秒兜底 |
| `timeoutMs` | `120000` | 空闲超时：超该时长没收到任何分块即超时，`0` 表示不设，超时按网关错误参与轮换 |

注意：原来的 `Web UI → 设置 → 模型 → 自定义提供方` 里如果也建了同名 `opencode-zen`，先删掉，否则会报 `DUPLICATE_ADAPTER`。

## 自测

1. 会话里选 `provider: opencode-zen`，模型从选择器挑（插件已上报目录），没有就手填免费 `ID`，透传给网关。
2. 发一句「你好」，不再秒 `429` 即成功。
3. 观察终端：受限时应打印 `[dsh-zen-spoof] xxx 受限，Nms 后换 yyy 重试`。
4. 真配额打满（`Free Usage Exceeded`）时插件也救不了，等第二天重置或切付费便宜模型兜底。

## 实现细节

* 文本块固定 `index 0`，工具块从 `1` 递增，满足 `StreamChunk` 从 `0` 递增的协议要求。
* 工具首包只有 `id + name` 时先宣告一次，后续 `arguments` 增量追加，不重复空包。
* 网关回包若不是 `SSE` 而是普通 `JSON`，自动按非流式解析，不会吞成空回复。
* 有工具块但网关没给 `finish_reason=tool_calls` 时，兜底成 `tool-calls`，保证 `Agent` 会执行工具。
* 中止信号直接透传，`ABORTED` 不参与轮换；断网、`DNS` 这类 `fetch` 原生错误会包成 `TRANSPORT`，`Agent` 循环才能识别重试。
* 请求体透传 `temperature`、`max_tokens`、`stop` 与完整工具定义，均按 `dsh-llm` 类型直接映射，不再猜字段名。
* 工具结果按真实形态解析（`source.kind === 'tool'`＋首块关联 `id`），图片附件按官方 `text-only` 策略用占位符保住位置，推理块不回传。
* 错误码与官方适配器同制：`AUTH／QUOTA／RATE_LIMIT／INVALID_REQUEST／SERVER／TIMEOUT／TRANSPORT／EMPTY_RESPONSE`，耗尽候选后上抛仍可被官方重试接住；`429` 先过配额分类器，`Retry-After` 与请求 `id` 进 `failure` 事实位。
* 历史里已有 `system` 消息时不再重复追加，避免发两条 `system`。
* `refusal` 按文本块下发，安全拒绝不会变成静默空轮。
* 无 `id` 的工具结果降级成 `user` 消息，避免网关 `400`；非流式下文本与拒绝合并成同一个 `0` 号块，不出现重复 `block-start`；对象形态的 `arguments` 统一序列化，空参数归一成 `{}`。
* 流中途断掉且已吐出过分块时不再换模型（避免同流索引碰撞），直接上抛给 `harness` 按步骤边界重试。
* 模型名带 `provider/` 前缀（如选择器拼出来的）自动剥掉，流里塞 `message` 代替 `delta`、数组形态 `content`、负数工具索引、带 `BOM` 的分块都做兼容。
* 状态码细分：`402` 按余额问题、`404／413／422` 按请求问题处理为不可重试，不再白烧轮换次数。
* 读完流释放 `reader` 锁，`usage` 取整，残缺配置只报 `LlmError` 不抛 `TypeError`；中止信号跨 `realm／polyfill` 按形状兼容，保证可取消。
* 工具调用关联用官方 `CallId` 品牌（`dsh-brand` 无运行时导出，不可直引）；`providerInfo／listModels／resolveModel` 按真实签名重写，选择器可见模型目录。
* `x-opencode-session` 优先用 `harness` 会话 `id`，回退到实例随机值。

## 兼容性

已对照 `F:\Program Files\dsh` 实装（`dsh 0.1.0-rc.6`，`dsh-llm 0.1.0-rc.8`）的类型声明逐项核对：`LlmAdapter／StreamChunk／GenerateOptions／Message／LlmError` 均为真实契约。同系列 `rc` 版一般兼容，大版本升级后请重跑 `pnpm check`。

## 发布到广场（可选）

想和广场插件一样一键安装，两条路（包结构已就绪，`prepare` 会自动构建）：

```powershell
# 路一：发 npm，之后 dsh plugin --profile web add dsh-zen-spoof
pnpm publish

# 路二：推 GitHub（仓库打 dsh-plugin topic），之后
#   dsh plugin --profile web add github:<你>/<仓库>
# 首次 git 安装按提示在 profile 的 pnpm-workspace.yaml 加 allowBuilds 放行
```

## 风险

伪装客户端头属于灰色手段，官方随时可能收紧，插件留了开关，关掉 `enableAutoFallback` 或卸载即回直连。
