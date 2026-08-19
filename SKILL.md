---
name: nanobot-run
description: >-
  Run the local nanobot AI agent (HKUDS/nanobot) as a subagent: dispatch a
  task to nanobot, let it execute with its own tools (files, shell, system,
  browser), and receive its final answer back. Use this to offload hands-on
  work while you keep planning and reasoning. 把本机 nanobot 作为子代理派出：
  派发任务、让它用自带工具执行、取回最终回答。适合把动手类工作外包出去，
  你继续负责规划与推理。
whenToUse: >-
  Use when a task needs actual execution — file operations, shell commands,
  system inspection, web/browser work, or anything that produces real
  artifacts — and you want a subagent to do it in the background while you
  keep the conversation. Call nanobot_run like spawning a worker; the result
  comes back as the tool result and enters your context.
metadata:
  version: 0.3.0
  plugin: dsh-tool-nanobot
  repo: https://github.com/2025Bigeye/dsh-nanobot-subagent-link
---

# nanobot-run — 把 NanoBot 作为子代理运行

## 这是什么

`nanobot_run` 是一个**子代理派遣工具**：你（DSH）通过它把一个任务派给本机
**nanobot**（HKUDS 的轻量 AI Agent），nanobot 作为你的子代理独立执行，
最后把它的最终回答作为工具结果返回给你。

一句话：**派出一个工具人，干完活，带着结果回到你的上下文里。**

```
你(DSH) ──派任务──▶ nanobot_run ──▶ nanobot(子代理)
                                         │ 用自己的工具执行
你(DSH) ◀──结果注入上下文── 工具结果 ◀──┘
```

## 核心用法：派活、执行、回收

1. **派活**：调用 `nanobot_run` 工具，`prompt` 里把任务写清楚——
   像给一个能干的同事交代工作：目标、路径/范围、约束、验收标准、期望产出。
2. **执行**：nanobot 收到任务后自己动手（它有文件、shell、系统、浏览器等工具），
   你不需要等待期间做别的——它是独立进程/独立请求。
3. **回收**：调用返回 nanobot 的最终回答，**结果自动注入你的上下文**，
   你可以直接基于它继续推理、追问、或派下一个任务。

## 参数

- **prompt**（必填）：派给子代理的任务描述。写得越具体，产出越接近预期。
- **mode**（可选）：`oneshot`（默认，每次独立拉起一个子代理实例）或
  `server`（常驻 API 服务，更快、支持并发，未启动会自动拉起）。
  单次简单任务用 `oneshot`；连续多个任务或高并发再切 `server`。
- **timeoutMs**（可选）：等待子代理返回的超时毫秒，默认 300000。
  超时后本次调用以错误返回，nanobot 进程会被终止，不会返回部分结果。

## 示例调用

最小示例（单次派活，默认 oneshot）：

```
nanobot_run(prompt="列出 C:\WORKSPACE 下的视频文件，按大小排序，返回前 5 个")
```

完整示例（server 模式 + 自定义超时）：

```
nanobot_run(
  prompt="把 C:\tmp\a.srt 与 C:\tmp\b.srt 合并为 c.srt，保持时间轴连续",
  mode="server",
  timeoutMs=120000
)
```

拿回结果后，把它当作普通工具输出继续推理：核对是否符合预期，
不行就换个 prompt 再派一次，或者基于结果追问下一步。

## 并行：多个工具人

想要并行就**多次调用** `nanobot_run`，每个任务单独派一次，不要挤在一个
prompt 里。每次调用都是一个独立子代理，可以同时跑，最后分别取回结果。

## 配置（DSH Settings → nanobot 命名空间）

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `oneshot` | 默认调用模式 |
| `oneshotCommand` | `nanobot agent -m "{prompt}" --no-markdown` | oneshot 命令模板，须恰好含一个 `{prompt}` |
| `serverBaseUrl` | `http://localhost:8900` | server 模式地址（仅允许 loopback） |
| `serverStartCommand` | `nanobot serve` | 自动拉起 server 的命令 |
| `serverModel` | *(空)* | 发送的 model；留空则服务器用配置模型 |

> `serverModel` 是高级字段：留空即可，服务器会用自己的配置模型；
> 只有服务器配置了固定 model_name 时才需要显式指定。

## 边界与约定

1. **命令模板/baseUrl 只来自可信用户配置**，不要试图让 nanobot 执行模型
   可控制的任意命令字符串——那不是子代理协议的一部分。
2. nanobot 的回答可能被截断（默认 20000 字符上限）；超长产出让它写文件。
3. nanobot 自己的沙箱会拦截 localhost/内网 URL 访问；需要浏览器/内网操作
   时它做不了，别硬派。
4. 派活时把验收标准写进去，拿回结果后**自己核验**是否符合预期，再决定
   是否迭代——子代理的结果值得检查，不要盲信。
