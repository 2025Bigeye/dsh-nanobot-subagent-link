# dsh-tool-nanobot · NanoBot子代理桥

> 让 DeepSeek Harness (DSH) 把本机 [nanobot](https://github.com/HKUDS/nanobot) 当作**子 Agent** 来运行。

[![npm](https://img.shields.io/npm/v/dsh-tool-nanobot)](https://www.npmjs.com/package/dsh-tool-nanobot)
[![license](https://img.shields.io/npm/l/dsh-tool-nanobot)](./LICENSE)

English | [中文](./README.zh.md)

安装后，DSH 获得一个名为 **`nanobot_run`** 的模型工具：把**一个自包含的子任务**交给 nanobot，它用自己的工具和上下文执行，**只返回最终答案**。插件同时注册 `nanobot-run` 运行时技能和一段提示引导，让新对话也能发现并使用这个能力。

## 安装

```sh
dsh plugin --profile web add dsh-tool-nanobot
```

重启 `dsh web` 后即可使用。需要 `dsh web >= 0.1.0-rc.6`，以及 PATH 上可用的本机 `nanobot` CLI。

## 用法

DSH 会自动调用 `nanobot_run`。两种调用模式：

- **`oneshot`**（默认）：每次任务运行 `nanobot agent -m <prompt>`（独立进程、无状态，最稳妥，适合互不相关的任务）。
- **`server`**：调用常驻 `nanobot serve` 的 OpenAI 兼容 API（`/v1/chat/completions`），更快；未运行时自动拉起。

## 配置（持久化于 DSH Settings）

在 **Settings → nanobot** 命名空间可配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `oneshot` | 默认调用模式：`oneshot` / `server` |
| `oneshotCommand` | `nanobot agent -m "{prompt}" --no-markdown` | oneshot 命令模板，须恰好包含一个 `{prompt}` 占位符 |
| `serverBaseUrl` | `http://localhost:8900` | server 模式地址（仅允许 loopback） |
| `serverStartCommand` | `nanobot serve` | 自动拉起 server 的命令 |
| `serverModel` | *(空)* | 要发送的 model；留空则省略（服务器自动用其配置的模型） |

## 安全说明

- 命令模板与 base URL **只来自可信的用户配置**，不接受模型可控参数（无命令 / URL 注入面）。
- server 模式的地址强制 **loopback 白名单**，API key 不会被发送到非本机地址。
- 沙箱感知执行，支持按会话的审批升级（`sandbox_permissions` + `justification`）。
- 输出做截断；插件卸载时会终止已启动的 server 进程。

## 环境要求

- DeepSeek Harness `dsh web >= 0.1.0-rc.6`
- 本机 [`nanobot`](https://github.com/HKUDS/nanobot) CLI（例如 `uv tool install nanobot-ai`）
- Windows：PowerShell（shell 服务使用）

## 开发

```sh
git clone https://github.com/2025Bigeye/dsh-nanobot-subagent-link.git
cd dsh-nanobot-subagent-link
npm install
```

## 变更日志

见 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT
