// dsh-tool-nanobot — run the local nanobot AI agent (HKUDS/nanobot) as a
// subagent from DSH. Registers the model-facing `nanobot_run` tool.
//
// Modes:
//   oneshot (default) — runs `nanobot agent -m <prompt>` per task.
//   server            — starts `nanobot serve` once and calls its
//                       OpenAI-compatible endpoint /v1/chat/completions
//                       (auth key read from ~/.nanobot/config.json).
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-tool-nanobot'
export const inject = ['tools', 'skills']

// Durable configuration, stored in the Host settings document. Users edit these
// in Settings (or the settings file) instead of them being hard-coded.
const NS = settingsNamespace('nanobot')
const SettingsSchema = z.object({
  mode: z.union(['oneshot', 'server']).default('oneshot'),
  oneshotCommand: z.string().default('nanobot agent -m "{prompt}" --no-markdown'),
  serverBaseUrl: z.string().default('http://localhost:8900'),
  serverStartCommand: z.string().default('nanobot serve'),
  // Empty means "omit model" — the server uses its configured model_name. A
  // non-empty value must match the server's model_name or it returns 400.
  serverModel: z.string().default(''),
})

export function apply(ctx) {
  // Register the durable configuration namespace when settings are composed.
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(NS, SettingsSchema)
  })
  const serverState = { started: false, handle: null, starting: null }
  // Always terminate a started nanobot serve process when this plugin tears down.
  ctx.effect(() => () => {
    if (serverState.handle !== null) {
      try { serverState.handle.kill() } catch { /* already gone */ }
      serverState.handle = null
      serverState.started = false
    }
  })
  const WIDER = {
    'read-only': ['workspace-write', 'danger-full-access'],
    'workspace-write': ['danger-full-access'],
  }

  const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"

  // Security guards: the command template and base URL come ONLY from the
  // user's trusted settings, never from model-controllable tool args, and they
  // are validated here (no injection, no non-loopback exfiltration).
  function safeExe(exe) {
    if (typeof exe !== 'string' || exe.length === 0) return null
    // A bare command name only: no path separators, spaces, or shell metacharacters.
    if (/[\\/:<>|&;()\s'"]/.test(exe)) return null
    return exe
  }
  function isLoopback(url) {
    let u
    try { u = new URL(url) } catch { return false }
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)
  }
  function truncate(text, max = 20000) {
    const t = String(text ?? '')
    return t.length > max ? t.slice(0, max) + '\n...[truncated]' : t
  }

  // Read the resolved configuration from DSH settings, falling back to defaults.
  function readConfig() {
    const settings = ctx.get('settings')
    let s = {}
    if (settings !== undefined) {
      const v = settings.get(NS)
      if (v && typeof v === 'object') s = v
    }
    return {
      mode: s.mode === 'server' ? 'server' : 'oneshot',
      oneshotCommand: typeof s.oneshotCommand === 'string' && s.oneshotCommand
        ? s.oneshotCommand
        : 'nanobot agent -m "{prompt}" --no-markdown',
      serverBaseUrl: typeof s.serverBaseUrl === 'string' && s.serverBaseUrl
        ? s.serverBaseUrl
        : 'http://localhost:8900',
      serverStartCommand: typeof s.serverStartCommand === 'string' && s.serverStartCommand
        ? s.serverStartCommand
        : 'nanobot serve',
      serverModel: typeof s.serverModel === 'string' ? s.serverModel : '',
    }
  }

  // Resolve the sandbox policy for one call; approval-gated escalation so
  // danger-full-access requires user consent (mirrors dsh-tool-bash).
  async function resolvePolicy(args, exec) {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const session = exec && exec.agent ? exec.agent.session : undefined
    const standing = sandboxPolicy === undefined
      ? undefined
      : sandboxPolicy.resolve(session === undefined ? {} : { session })
    const requested = args.sandbox_permissions
    if (requested === undefined) return standing
    if (typeof args.justification !== 'string' || !args.justification.trim()) {
      throw new Error('invalid escalation: sandbox_permissions requires a non-empty justification')
    }
    const effective = standing && standing.mode ? standing.mode : 'read-only'
    if (!(WIDER[effective] || []).includes(requested)) {
      throw new Error('sandbox escalation to "' + requested + '" is not strictly wider than this call\'s current "' + effective + '" mode')
    }
    const approval = ctx.get('approval')
    if (approval === undefined) throw new Error('sandbox escalation to "' + requested + '" requires approval, but no approval service is composed')
    if (!exec || exec.agent === undefined) throw new Error('sandbox escalation to "' + requested + '" requires approval, but the call has no agent to route it through')
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'nanobot_run',
      callId: exec.callId,
      reason: 'escalate sandbox to ' + requested + ': ' + args.justification,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (outcome !== 'allowed-once') throw new Error('sandbox escalation to "' + requested + '" was not approved (' + outcome + ')')
    return sandboxPolicy.resolve({ ...(session === undefined ? {} : { session }), mode: requested })
  }

  // Run one nanobot task; returns a small owned JSON result.
  async function runNanobot(args, exec) {
    const shell = ctx.get('shell')
    if (shell === undefined) throw new Error('shell service is not available')
    const a = args && typeof args === 'object' ? args : {}
    const cfg = readConfig()
    const prompt = String(a.prompt ?? '')
    if (!prompt.trim()) throw new Error('prompt is required')
    const mode = a.mode === 'server' ? 'server' : a.mode === 'oneshot' ? 'oneshot' : cfg.mode
    const timeoutMs = typeof a.timeoutMs === 'number' ? a.timeoutMs : 300000
    const policy = await resolvePolicy(a, exec)
    const base = {
      timeoutMs,
      ...(policy ? { sandboxPolicy: policy } : {}),
      ...(exec && exec.signal ? { signal: exec.signal } : {}),
    }

    if (mode === 'server') {
      // Restart the server if its process is no longer running.
      const h = serverState.handle
      if (serverState.started && h !== null && h.status !== 'running') {
        serverState.handle = null
        serverState.started = false
      }
      if (!serverState.started && serverState.handle === null) {
        // Serialize concurrent spawns so parallel calls never start two servers.
        if (serverState.starting) {
          await serverState.starting
        } else {
          serverState.starting = (async () => {
            serverState.handle = shell.start(shell.resolve({ command: cfg.serverStartCommand, ...(policy ? { sandboxPolicy: policy } : {}) }))
            serverState.started = true
          })()
          try { await serverState.starting } finally { serverState.starting = null }
        }
      }
      // baseUrl comes ONLY from trusted settings and must be loopback, so the
      // API key can never be sent to an attacker-controlled address.
      const baseUrl = String(cfg.serverBaseUrl).replace(/\/+$/, '')
      if (!isLoopback(baseUrl)) throw new Error('nanobot serverBaseUrl must be a loopback http URL (localhost/127.0.0.1/::1)')
      const model = String(cfg.serverModel)
      const u = baseUrl + '/v1/chat/completions'
      const script = [
        "$ErrorActionPreference='Stop'",
        '$p=' + psQuote(prompt),
        '$u=' + psQuote(u),
        '$m=' + psQuote(model),
        "$cfgPath=Join-Path $env:USERPROFILE '.nanobot\\config.json'",
        "$apiKey=''",
        'if (Test-Path $cfgPath) { $nb=Get-Content $cfgPath -Raw | ConvertFrom-Json; if ($nb.api -and $nb.api.apiKey) { $apiKey=[string]$nb.api.apiKey } }',
        "$headers=@{}",
        'if ($apiKey) { $headers["Authorization"]="Bearer "+$apiKey }',
        "if ($m) { $body=@{model=$m;messages=@(@{role='user';content=$p})} } else { $body=@{messages=@(@{role='user';content=$p})} }",
        '$body=$body|ConvertTo-Json -Depth 20 -Compress',
        "$lastErr=''",
        'for ($i=0; $i -lt 25; $i++) {',
        '  try {',
        "    $r=Invoke-RestMethod -Uri $u -Method Post -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 110",
        '    break',
        '  } catch {',
        '    $resp=$_.Exception.Response',
        '    $status=if ($resp) { [int]$resp.StatusCode } else { 0 }',
        '    $lastErr=$_.Exception.Message',
        // 4xx = bad request (model/key/etc) — fail fast with an actionable error.
        '    if ($status -ge 400 -and $status -lt 500) { Write-Error \"nanobot API rejected the request (HTTP $status): $lastErr\"; exit 1 }',
        // connection refused / 5xx — server still starting or overloaded; retry.
        '    if ($i -eq 24) { Write-Error \"nanobot server not reachable at $u after retries: $lastErr\"; exit 1 }',
        '    Start-Sleep -Seconds 1',
        '  }',
        '}',
        "if ($r.choices -and $r.choices[0].message) { $r.choices[0].message.content } else { $r | ConvertTo-Json -Depth 20 }",
      ].join('\n')
      const result = await shell.run(shell.resolve({ command: script, ...base }))
      return { ok: result.exitCode === 0, exitCode: result.exitCode, output: truncate(result.stdout.text), stderr: truncate(result.stderr.text) }
    }

    // Robust prompt transport: base64-encode the prompt, then launch nanobot via
    // .NET ProcessStartInfo with a manually-escaped Arguments string. The command
    // template comes only from trusted settings and is validated (safe exe, and
    // exactly one {prompt} placeholder) to prevent injection.
    const template = String(cfg.oneshotCommand).trim()
    const promptCount = (template.match(/\{prompt\}/g) || []).length
    if (promptCount !== 1) throw new Error('nanobot oneshotCommand must contain exactly one {prompt} placeholder')
    const spaceIdx = template.indexOf(' ')
    const exe = spaceIdx === -1 ? template : template.slice(0, spaceIdx)
    if (safeExe(exe) === null) throw new Error('nanobot oneshotCommand must start with a safe bare command name (no path, spaces, or shell metacharacters)')
    const b64 = Buffer.from(prompt, 'utf8').toString('base64')
    let argsPart = spaceIdx === -1 ? '' : template.slice(spaceIdx + 1)
    // Split the argument template on the {prompt} placeholder, then wrap each
    // fragment (including any surrounding quotes) in a PS single-quoted literal
    // joined by ' + $__e + '. This yields e.g.:
    //   $__psi.Arguments = 'agent -m "' + $__e + '" --no-markdown'
    const frags = argsPart.split('{prompt}')
    const argsExpr = frags.map((f) => "'" + f.replace(/'/g, "''") + "'").join(' + $__e + ')
    const script = [
      "$ErrorActionPreference='Stop'",
      "$__nb=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
      "$__e = $__nb -replace '\"', '\\\"'",
      '$__psi = New-Object System.Diagnostics.ProcessStartInfo',
      "$__psi.FileName = '" + exe + "'",
      '$__psi.UseShellExecute = $false',
      '$__psi.RedirectStandardOutput = $true',
      '$__psi.RedirectStandardError = $true',
      '$__psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8',
      '$__psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8',
      '$__psi.Arguments = ' + argsExpr,
      '$__proc = [System.Diagnostics.Process]::Start($__psi)',
      '$__out = $__proc.StandardOutput.ReadToEnd()',
      '$__err = $__proc.StandardError.ReadToEnd()',
      '$__proc.WaitForExit()',
      'Write-Output $__out',
      'if ($__err) { Write-Output "[stderr]`n$__err" }',
      'exit $__proc.ExitCode',
    ].join('\n')
    const command = script
    const result = await shell.run(shell.resolve({ command, ...base }))
    return { ok: result.exitCode === 0, exitCode: result.exitCode, output: truncate(result.stdout.text), stderr: truncate(result.stderr.text) }
  }

  const tool = defineTool({
    name: 'nanobot_run',
    description: 'Delegate a subtask to the local nanobot AI agent (HKUDS/nanobot) and return its final answer. Use this when a task should be handled by nanobot. Mode "oneshot" (default) runs `nanobot agent -m <prompt>`; mode "server" calls the running nanobot OpenAI-compatible server at <serverBaseUrl>/v1/chat/completions (auth key read from ~/.nanobot/config.json) and starts the server once if needed. Defaults are configured in DSH Settings (namespace "nanobot"); per-call overrides take precedence.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The task/prompt to send to nanobot.' },
      mode: { type: 'string', enum: ['oneshot', 'server'], description: 'Override the default invocation mode.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds for the nanobot call (default 300000).' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Wider sandbox mode for the nanobot command; requires justification and user approval.' },
      justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence explaining why the nanobot command needs the wider access.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          output: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? String(value.output)
          : 'nanobot failed (exit ' + String(value.exitCode) + '):\n' + String(value.stderr || '(no stderr)') + '\n' + String(value.output),
      }],
    },
    async execute(args, exec) {
      return runNanobot(args, exec)
    },
  })

  ctx.tools.register(tool)

  // Register this tool capability as a runtime skill so the model sees it in
  // the skill catalog and can load full instructions via the skill tool.
  // Single source of truth: SKILL.md ships with the package. Prefer reading it
  // at apply() time so the registered body never drifts from the published
  // doc; fall back to the embedded copy when the file is absent (e.g. an older
  // pnpm file: link that predates SKILL.md).
  const SKILL_FALLBACK = [
    '# nanobot-run — 把 NanoBot 作为子代理运行',
    '',
    '## 这是什么',
    '',
    '`nanobot_run` 是一个**子代理派遣工具**：你（DSH）通过它把一个任务派给本机',
    '**nanobot**（HKUDS 的轻量 AI Agent），nanobot 作为你的子代理独立执行，',
    '最后把它的最终回答作为工具结果返回给你。',
    '',
    '一句话：**派出一个工具人，干完活，带着结果回到你的上下文里。**',
    '',
    '```',
    '你(DSH) ──派任务──▶ nanobot_run ──▶ nanobot(子代理)',
    '                                         │ 用自己的工具执行',
    '你(DSH) ◀──结果注入上下文── 工具结果 ◀──┘',
    '```',
    '',
    '## 核心用法：派活、执行、回收',
    '',
    '1. **派活**：调用 `nanobot_run` 工具，`prompt` 里把任务写清楚——',
    '   像给一个能干的同事交代工作：目标、路径/范围、约束、验收标准、期望产出。',
    '2. **执行**：nanobot 收到任务后自己动手（它有文件、shell、系统、浏览器等工具），',
    '   你不需要等待期间做别的——它是独立进程/独立请求。',
    '3. **回收**：调用返回 nanobot 的最终回答，**结果自动注入你的上下文**，',
    '   你可以直接基于它继续推理、追问、或派下一个任务。',
    '',
    '## 参数',
    '',
    '- **prompt**（必填）：派给子代理的任务描述。写得越具体，产出越接近预期。',
    '- **mode**（可选）：`oneshot`（默认，每次独立拉起一个子代理实例）或',
    '  `server`（常驻 API 服务，更快、支持并发，未启动会自动拉起）。',
    '- **timeoutMs**（可选）：等待子代理返回的超时毫秒，默认 300000。',
    '',
    '## 并行：多个工具人',
    '',
    '想要并行就**多次调用** `nanobot_run`，每个任务单独派一次，不要挤在一个',
    'prompt 里。每次调用都是一个独立子代理，可以同时跑，最后分别取回结果。',
    '',
    '## 配置（DSH Settings → nanobot 命名空间）',
    '',
    '| 字段 | 默认 | 说明 |',
    '|---|---|---|',
    '| `mode` | `oneshot` | 默认调用模式 |',
    '| `oneshotCommand` | `nanobot agent -m "{prompt}" --no-markdown` | oneshot 命令模板，须恰好含一个 `{prompt}` |',
    '| `serverBaseUrl` | `http://localhost:8900` | server 模式地址（仅允许 loopback） |',
    '| `serverStartCommand` | `nanobot serve` | 自动拉起 server 的命令 |',
    '| `serverModel` | *(空)* | 发送的 model；留空则服务器用配置模型 |',
    '',
    '## 边界与约定',
    '',
    '1. **命令模板/baseUrl 只来自可信用户配置**，不要试图让 nanobot 执行模型',
    '   可控制的任意命令字符串——那不是子代理协议的一部分。',
    '2. nanobot 的回答可能被截断（默认 20000 字符上限）；超长产出让它写文件。',
    '3. nanobot 自己的沙箱会拦截 localhost/内网 URL 访问；需要浏览器/内网操作',
    '   时它做不了，别硬派。',
    '4. 派活时把验收标准写进去，拿回结果后**自己核验**是否符合预期，再决定',
    '   是否迭代——子代理的结果值得检查，不要盲信。',
  ].join('\n')

  let skillContent = SKILL_FALLBACK
  try {
    const md = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8')
    const body = md.replace(/^---[\s\S]*?---\s*/, '').trim()
    if (body) skillContent = body
  } catch { /* keep fallback */ }

  const skills = ctx.get('skills')
  if (skills) {
    skills.register({
      name: 'nanobot-run',
      description:
        'Run the local nanobot AI agent as a subagent to do hands-on work: file ops, shell commands, system inspection, and relaying to a remote WeChat user. DSH stays the planner; nanobot is the executor.',
      content: skillContent,
      whenToUse:
        'Use when a task is practical and executable (files, commands, system state, user relay) and a second pair of hands helps: offload execution, parallelize subtasks, or bridge to a remote WeChat user. Do not use for pure planning or deep reasoning.',
      metadata: {
        name: 'nanobot-run',
        version: '0.2.0',
        plugin: 'dsh-tool-nanobot',
        repo: 'https://github.com/2025Bigeye/dsh-nanobot-subagent-link',
      },
    })
  } else {
    console.warn('[dsh-tool-nanobot] skills service unavailable; nanobot-run skill not registered')
  }
}

export default { name, apply, inject }
