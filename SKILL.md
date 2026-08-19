---
name: nanobot-run
description: >-
  Run the local nanobot AI agent (HKUDS/nanobot) as a subagent to do the
  hands-on work: file operations, shell commands, system inspection, and
  relaying between DSH and a remote WeChat user. DSH stays the planner;
  nanobot is the executor. 把本机 nanobot 当作子代理执行具体任务（文件/命令/系统
  操作/微信中转），DSH 负责规划与推理，nanobot 负责动手。
whenToUse: >-
  Use when a task is practical and executable (files, commands, system state,
  user-facing relay) and a second pair of hands helps: offload execution,
  parallelize independent subtasks, or bridge to the user who is controlling
  the machine remotely through WeChat. Do not use for pure planning, coding
  design, or deep reasoning — keep those in DSH.
metadata:
  version: 0.2.0
  plugin: dsh-tool-nanobot
  repo: https://github.com/2025Bigeye/dsh-nanobot-subagent-link
---

# nanobot-run — 把本机 NanoBot 当子代理用

## 这是什么

`nanobot_run` 是 dsh-tool-nanobot 插件（"NanoBot子代理桥"）注册给 DSH 的模型工具。
调用它 = 派一个任务给本机 **nanobot**（HKUDS 的轻量 AI Agent），取回它的最终回答。
一次派多个就是多 worker 并行。

## 背景：当前工作环境很特殊

- 用户通过 **微信远程操控** 本机，人不在电脑前。
- 用户无法现场制约工作，一切指令经 nanobot 中转。
- DSH 与 nanobot 的分工：**DSH = 大脑/导演（规划、推理、代码）**，
  **nanobot = 手脚/执行者（文件、命令、系统、传话）**。
- nanobot 的沙箱会拦截对 localhost/内网 URL 的访问，无法代替浏览器操作；
  长输出应写成文件放入工作区 `C:\Users\big_e\.nanobot\workspace` 转交。

## 怎么用（调用 nanobot_run 工具）

- **prompt**（必填）：把任务写清楚，就像给一个人同事交代工作一样。
  带上必要上下文（路径、约束、验收标准）。
- **mode**（可选）：`oneshot`（默认，每次独立进程）或 `server`（常驻 API，
  更快、支持并发；未启动会自动拉起）。
- **timeoutMs**（可选）：超时毫秒，默认 300000。
- 想要并行就把多个任务分别调 `nanobot_run`，不要挤在一个 prompt 里。

## 配置（DSH Settings → nanobot 命名空间）

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `oneshot` | 默认调用模式 |
| `oneshotCommand` | `nanobot agent -m "{prompt}" --no-markdown` | oneshot 命令模板，须恰好含一个 `{prompt}` |
| `serverBaseUrl` | `http://localhost:8900` | server 模式地址（仅允许 loopback） |
| `serverStartCommand` | `nanobot serve` | 自动拉起 server 的命令 |
| `serverModel` | *(空)* | 发送的 model；留空则服务器用配置模型 |

## 约定与边界

1. **命令模板/baseUrl 只来自可信用户配置**，不要试图让 nanobot 执行模型可控制的
   任意命令字符串。
2. nanobot 的回答可能被截断（默认 20000 字符上限）。
3. 需要用户确认的事：先告诉 nanobot，由它转告微信里的用户。
4. 跑完长任务后，把结果摘要回报给用户，别让用户自己翻日志。
