#  NanoBot子代理桥 (NanoBot Subagent Bridge)

让 DeepSeek Harness (DSH) 把本机 **nanobot**（HKUDS 的超轻量 AI Agent）当作**子 Agent** 来运行。

安装后，DSH 获得一个名为 **`nanobot_run`** 的模型工具：可以把子任务直接派给 nanobot，取回它的最终回答

## 安装

```sh
dsh plugin --profile web add dsh-tool-nanobot
```

重启 `dsh web` 后即可使用。需要 `dsh web >= 0.1.0-rc.6`。

## 用法

由 DSH 自动调用 `nanobot_run`；也可显式指定模式：

- **`oneshot`**（默认）：每次任务运行 `nanobot agent -m <prompt>`（独立进程）。
- **`server`**：调用常驻 `nanobot serve` 的 OpenAI 兼容 API（`/v1/chat/completions`），更快的多轮/并发；未运行时自动拉起。

## 配置（持久化于 DSH Settings）

在 **Settings → nanobot** 命名空间可配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `oneshot` | 默认调用模式：`oneshot` / `server` |
| `oneshotCommand` | `nanobot agent -m "{prompt}" --no-markdown` | oneshot 命令模板，须恰好包含一个 `{prompt}` 占位符 |
| `serverBaseUrl` | `http://localhost:8900` | server 模式地址（仅允许 loopback） |
| `serverStartCommand` | `nanobot serve` | 自动拉起 server 的命令 |
| `serverModel` | *(空)* | 要发送的 model；留空则省略（服务器自动用配置模型） |

## 安全说明

- 命令模板与 base URL **只来自可信的用户配置**，不接受模型可控参数（已移除 `command`/`baseUrl` 注入面）。
- server 模式的地址强制 **loopback 白名单**，API key 不会被发送到非本机地址。
- 支持按会话沙箱审批升级（`sandbox_permissions` + `justification`）。
- 输出做截断，避免全量转储。

## 开发

```sh
git clone <your-repo> && cd dsh-tool-nanobot
npm install   # 安装 peer 依赖以本地自测
```

## License

MIT
