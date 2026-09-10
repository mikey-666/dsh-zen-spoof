# dsh-zen-spoof

在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 里直连 [OpenCode Zen](https://opencode.ai) 免费模型的适配器插件。

[![npm version](https://img.shields.io/npm/v/dsh-zen-spoof)](https://www.npmjs.com/package/dsh-zen-spoof)
[![license](https://img.shields.io/npm/l/dsh-zen-spoof)](LICENSE)

## 它解决什么问题

Zen 的免费档只对 OpenCode 官方客户端开放。服务端通过以下 HTTP headers 判断请求来源：

| Header | 值 |
|---|---|
| `User-Agent` | `opencode/<版本号>` |
| `x-opencode-client` | `cli` |
| `x-opencode-session` | `ses_<随机ID>` |
| `x-opencode-request` | `msg_<随机ID>` |
| `x-opencode-project` | `global` |

缺少或格式不对会被拒绝（`400: MissingSessionID`）。

dsh 内置的 `dsh-llm-pi-ai` 适配器**理论上**支持注入这些 headers，但有一个缺陷：

> pi-ai 的 `requestHeaders()` 用 `attributionHeaders()`（固定返回 `user-agent: deepseek-harness/...`）
> **覆盖**用户自定义的 `User-Agent`，导致 opencode 检测永远失败，headers 永远不被注入。
> 虽然 dsh 安装器会在本地打 `zen-useragent:patched-v2` 补丁修复此问题，但：
> - 该补丁不在 npm 包内，随安装器版本而异
> - dsh 升级后可能丢失

**本插件的方案**：直接注册为 `opencode` provider，完全绕过 pi-ai，自行控制所有请求 headers。
不依赖任何补丁，任何 dsh 版本均可使用。

## 安装

```powershell
# npm
dsh plugin --profile web add dsh-zen-spoof

# GitHub
dsh plugin --profile web add github:mikey-666/dsh-zen-spoof
```

### 必须手动完成的一步

插件注册为 `opencode` provider，与 pi-ai 的同名路由冲突。
**安装后必须**编辑 `settings.yaml`，注释掉 `opencode` provider：

```yaml
llm-pi-ai:
  providers:
    # opencode: 已由 dsh-zen-spoof 插件接管
    opencode-go:
      # ... 你的其他 provider 配置保持不变 ...
```

`settings.yaml` 位置：

| 系统 | 典型路径 |
|---|---|
| Windows | `<dsh安装目录>\.dsh\settings.yaml` |
| macOS / Linux | `~/.dsh/settings.yaml` |

可在 dsh web UI「设置」页查看，或执行 `dsh config` 查找。

跳过此步会报 `DUPLICATE_ADAPTER` 错误。

## 使用

```powershell
dsh web
```

在会话里选 `provider: opencode`，模型挑任意免费 ID：

| 模型 ID | 说明 |
|---|---|
| `mimo-v2.5-free` | MiMo V2.5（默认） |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash |
| `ling-3.0-flash-free` | Ling 3.0 Flash |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra |

> **模型自动发现**：插件启动时自动调用 Zen API 获取最新免费模型列表，上表仅供参考。

API Key 自动复用 dsh 凭据库中 `OPENCODE_API_KEY` 的值，无需额外配置。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | 空 | 留空则自动读取 dsh 凭据库 |
| `apiKeyRef` | `OPENCODE_API_KEY` | 凭据引用名 |
| `baseURL` | `https://opencode.ai/zen/v1` | 网关地址 |
| `providers` | `["opencode"]` | 注册的路由名 |
| `spoofClient` | `cli` | `x-opencode-client` 值 |
| `project` | `dsh` | `x-opencode-project` 值 |
| `userAgent` | `opencode/1.18.30` | `User-Agent`，须含版本号 |
| `enableAutoFallback` | `true` | 受限时自动换模型 |
| `maxFallbackAttempts` | `5` | 单次最多换几个 |
| `initialBackoffMs` | `1000` | 退避起点 |
| `maxBackoffMs` | `30000` | 退避上限 |
| `timeoutMs` | `120000` | 空闲超时（ms），`0` 不限 |

通过 cordis 配置覆盖时须重述全部键。

## 特性

- **完全自包含**——不依赖 pi-ai 补丁或特定版本
- **模型自动发现**——启动时从 Zen API 获取最新免费模型列表，失败时 fallback 到内置列表
- **思考模式**——自动透传 `reasoning_effort` 给 Zen API，解析 `reasoning_content` 字段并在 dsh UI 中显示思考过程
- **自动 fallback**——429 / 5xx 时在候选池内轮换模型，指数退避 + `Retry-After` 支持
- **凭据热更新**——逐请求解析 key，换 key 不用重启
- **错误码对齐**——可被 harness 自带重试机制接住
- **多 block 输出**——正确处理 reasoning → text → tool-call 的流式组装顺序

## 卸载

```powershell
dsh plugin --profile web remove dsh-zen-spoof
```

卸载后在 `settings.yaml` 中恢复 `opencode` provider 配置（如需恢复 pi-ai 路由）。

## 工作原理

1. 插件通过 `ctx.llm.registerAdapter(["opencode"], adapter)` 注册路由
2. 由于 `settings.yaml` 中 `opencode` 已被注释，pi-ai 不会注册同名路由，无冲突
3. 每次请求时，插件自行构建 headers：
   - `User-Agent: opencode/1.18.30`（触发服务端免费档白名单）
   - `x-opencode-session: ses_<稳定ID>`（per-conversation，用于服务端分桶）
   - `x-opencode-request: msg_<随机ID>`（per-request，用于追踪）
   - `x-opencode-client: cli` + `x-opencode-project: dsh`
4. 直接调用 `fetch()` 发送到 Zen 网关，完全绕过 pi-ai 的 header 处理链
5. 解析 SSE 流时，将 `reasoning_content` 转为 `reasoning-delta` chunk，`content` 转为 `text-delta` chunk，与 dsh 的 BlockAssembler 协议完全对齐

## 风险

伪装客户端头属于灰色手段，官方随时可能收紧策略。
有社区报告称官方会标记非官方客户端的流量，介意请使用小号 Key 或切换付费模型。

## License

[MIT](LICENSE)
