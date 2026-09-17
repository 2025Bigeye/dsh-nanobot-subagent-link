# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [Unreleased]

### Fixed

- **失败原因不清晰**：插件此前忽略 shell 返回的 `timedOut` / `aborted` / `signal` 字段，超时或取消时只显示 `nanobot failed (exit 1): (no stderr)`，无法判断真实原因。新增失败分类，现在会明确报告 `timed out after Nms` / `aborted (the tool call was cancelled)` / `killed by signal X` / `process ended without an exit code`。

## [0.4.1] - 2026-09-17

### Added

- **工具可发现性**：注册一段系统提示引导（`systemPrompt` section，order 106），说明 `nanobot_run` 的用途与适用场景。此前仅注册工具，新对话的模型没有任何线索，几乎不会主动使用它。
- 英文 `README.md`（市场主 README）与中文 `README.zh.md` 双语。
- 补齐市场规范所需的包元数据：`repository` / `homepage` / `bugs`，`exports` 增加 `./SKILL.md`，`files` 纳入 `CHANGELOG.md` 与双语 README。

### Changed

- 工具描述重写：把"何时使用"前置，精简实现细节噪声。

### Fixed

- **server 模式中文乱码（严重）**：请求体改以 UTF-8 字节发送，并在 `Content-Type` 声明 `charset=utf-8`。此前 PowerShell 5.1 的 `Invoke-RestMethod -Body <字符串>` 默认按 Latin1 编码发送，中文提示词到达 nanobot 时已是乱码，导致它只能靠上下文猜测、答非所问。
- **server 模式会话污染**：每次调用传入独立的 `session_id`。此前不传该字段时，全部请求都落在 server 的同一个默认会话里，历史对话会串入新的、无关的任务。
- **oneshot 输出噪音**：剥离 `👀` 模型横幅与 `✻` 前缀的推理行，只保留最终答案；并把启动器追加的 `[stderr]` 段从 stdout 分离到 `stderr` 字段。

## [0.4.0] - 2026-09-17

### Changed

- 魔法数字提取为具名常量：默认超时（`DEFAULT_TIMEOUT_MS`）、输出截断上限（`MAX_OUTPUT_CHARS`）、server 重试次数/间隔/请求超时（`SERVER_RETRY_ATTEMPTS` / `SERVER_RETRY_INTERVAL_SEC` / `SERVER_REQUEST_TIMEOUT_SEC`）、JSON 序列化深度（`JSON_CONVERT_DEPTH`），集中置于文件顶部，便于维护与调优。
- 统一日志标签：提取重复的 `[dsh-tool-nanobot]` 前缀为 `LOG_TAG` 常量。

### Fixed

- server 启动增加 try-catch 保护：失败时回滚 `serverState` 并抛出含命令与根因的可操作错误，不再裸冒泡原始 spawn/resolve 失败。
- server 启动失败时增加诊断日志（`console.error`），便于定位问题。

## [0.3.0] - 2026-08-19

### Added

- 运行时技能注册：将 `nanobot_run` 工具同时注册为 DSH 技能 `nanobot-run`。
- 新增 `SKILL.md` 技能文档（含 frontmatter 元数据：`description` / `whenToUse` / `version`）。
- 技能正文采用子代理派遣协议（派活 → 执行 → 回收）。
- 补充调用示例、oneshot/server 模式选择指南、超时与失败语义说明。

### Changed

- 技能元数据改为单一事实源：`apply()` 时从 `SKILL.md` 读取，移除内嵌 fallback 副本，避免文档与实现漂移。
- 技能正文聚焦子代理派遣机制。

### Fixed

- 版本号统一为 `0.3.0`（`package.json`、`SKILL.md`、技能元数据三者一致）。

## [0.2.0] - 2026-08-18

### Added

- `nanobot_run` 工具：支持 oneshot CLI 模式与持久化 OpenAI 兼容 server 模式。
- DSH Settings 持久化配置命名空间 `nanobot`（`mode` / `oneshotCommand` / `serverBaseUrl` / `serverStartCommand` / `serverModel`）。
- 安全加固：命令模板与 `baseUrl` 仅来自可信配置，移除模型可控的注入面；server 模式强制 loopback 白名单；输出截断。
- server 进程生命周期管理：惰性启动、存活检测、插件卸载时自动终止。
- 并发防竞态：串行化并行 spawn，避免同时启动两个 server 实例。
- 4xx 快速失败：参数 / 模型 / 鉴权问题立即返回可操作错误，不进入重试；仅连接失败与 5xx 走重试。
- 沙箱感知执行：按会话策略执行，支持审批门控的沙箱升级。
- 项目基础文件：`README.md`、`LICENSE`、`.gitignore`、`cordis.patch.yml`（声明 `dsh.bundle`，安装后自动挂载组合行）。

### Changed

- 优化 `README.md` 标题与描述清晰度。
- 补充项目状态（WIP）与使用详情。

## [0.1.0]

早期本机原型版本（未纳入版本控制）：直接注册 `nanobot_run` 工具，仅支持 oneshot 模式，配置硬编码在插件内。
