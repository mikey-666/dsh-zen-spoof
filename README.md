# dsh-zen-spoof

在 `DeepSeek Harness` 里直连 `OpenCode Zen` 免费模型的适配器插件。

`Zen` 的免费档只认 `OpenCode` 官方客户端（`User-Agent` 必须长成 `opencode/<版本号>` 完整形态），
第三方直接调会被按最严档限流甚至拒掉。本插件注册一条 `opencode-zen` 路由，
替每次请求补上官方客户端头，并把免费模型轮换池、指数退避、`Retry-After` 一并管好。

## 安装

```powershell
# npm 包名安装
dsh plugin --profile web add dsh-zen-spoof

# 或从 GitHub 安装（首次按提示在 profile 的 pnpm-workspace.yaml 加 allowBuilds 放行）
dsh plugin --profile web add github:mikey-666/dsh-zen-spoof
```

装完不用改任何配置，直接启动：

```powershell
dsh web
```

本地目录安装（二次开发用）：

```powershell
cd dsh-zen-spoof
pnpm install
pnpm build
dsh plugin --profile web add .
```

## 使用

会话里选 `provider： opencode-zen`，模型挑任一免费 `ID`：

```text
big-pickle
mimo-v2.5-free
ling-3.0-flash-fin-free
nemotron-3-ultra-free
nemotron-3.5-lightning-free
```

`Key` 自动复用 `dsh` 设置里 `opencode` 提供方的存量值，不用设环境变量。
卸载：`dsh plugin --profile web remove dsh-zen-spoof`。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | 空 | 为空时自动复用 `dsh` 凭据库存量 |
| `apiKeyRef` | `OPENCODE_API_KEY` | 复用的凭据引用名 |
| `baseURL` | `https://opencode.ai/zen/v1` | 网关地址 |
| `providers` | `["opencode-zen"]` | 路由名，勿与现有提供方重名 |
| `models` | 见上 `5` 个免费模型 | `429` 时轮换的候选池 |
| `enableAutoFallback` | `true` | 受限时是否自动换模型 |
| `maxFallbackAttempts` | `5` | 单次最多换几个 |
| `initialBackoffMs` | `1000` | 退避起点 |
| `maxBackoffMs` | `30000` | 退避上限 |
| `timeoutMs` | `120000` | 空闲超时，`0` 表示不设 |
| `userAgent` | `opencode/1.18.30` | 伪装的 `User-Agent`，须带完整版本号 |

覆盖配置时须重述全部键（`harness` 补丁层语义）。

## 特性

* 官方客户端头伪装（`User-Agent` 版本形态＋`x-opencode-*` 会话头）。
* 受限自动换模型，指数退避并尊重网关 `Retry-After`。
* 错误码与官方适配器同制，可被 `harness` 自带重试接住。
* 模型目录自动上报，选择器可见。
* 凭据逐请求解析，换 `Key` 不重启。

## 风险

伪装客户端头属于灰色手段，官方随时可能收紧；
有社区报告称官方会标记伪装流量的账号，介意请用小号 `Key` 或切付费模型。
