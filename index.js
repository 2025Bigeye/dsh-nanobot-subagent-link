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

// Tuning constants — centralized so they're easy to find and adjust.
const DEFAULT_TIMEOUT_MS = 300000 // default nanobot call timeout (5 minutes)
const MAX_OUTPUT_CHARS = 20000 // stdout/stderr truncation cap
const SERVER_RETRY_ATTEMPTS = 25 // API retry attempts while the server boots
const SERVER_RETRY_INTERVAL_SEC = 1 // pause between server-API retries
const SERVER_REQUEST_TIMEOUT_SEC = 110 // per-request timeout (under nanobot api.timeout=120s)
const JSON_CONVERT_DEPTH = 20 // ConvertTo-Json -Depth for request/response

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
  function truncate(text, max = MAX_OUTPUT_CHARS) {
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
    const timeoutMs = typeof a.timeoutMs === 'number' ? a.timeoutMs : DEFAULT_TIMEOUT_MS
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
        '$body=$body|ConvertTo-Json -Depth ' + JSON_CONVERT_DEPTH + ' -Compress',
        "$lastErr=''",
        'for ($i=0; $i -lt ' + SERVER_RETRY_ATTEMPTS + '; $i++) {',
        '  try {',
        "    $r=Invoke-RestMethod -Uri $u -Method Post -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec " + SERVER_REQUEST_TIMEOUT_SEC,
        '    break',
        '  } catch {',
        '    $resp=$_.Exception.Response',
        '    $status=if ($resp) { [int]$resp.StatusCode } else { 0 }',
        '    $lastErr=$_.Exception.Message',
        // 4xx = bad request (model/key/etc) — fail fast with an actionable error.
        '    if ($status -ge 400 -and $status -lt 500) { Write-Error \"nanobot API rejected the request (HTTP $status): $lastErr\"; exit 1 }',
        // connection refused / 5xx — server still starting or overloaded; retry.
        '    if ($i -eq ' + (SERVER_RETRY_ATTEMPTS - 1) + ') { Write-Error \"nanobot server not reachable at $u after retries: $lastErr\"; exit 1 }',
        '    Start-Sleep -Seconds ' + SERVER_RETRY_INTERVAL_SEC,
        '  }',
        '}',
        "if ($r.choices -and $r.choices[0].message) { $r.choices[0].message.content } else { $r | ConvertTo-Json -Depth " + JSON_CONVERT_DEPTH + " }",
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
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds for the nanobot call (default ' + DEFAULT_TIMEOUT_MS + ').' },
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
  // Single source of truth: SKILL.md ships with the package. Its frontmatter
  // (description/whenToUse/version) and body are read at apply() time, so the
  // registered skill can never drift from the published doc. There is no
  // embedded fallback copy by design — if SKILL.md is missing, the runtime
  // skill is skipped (the nanobot_run tool itself still works).
  const skills = ctx.get('skills')
  if (skills) {
    let mdText = null
    try {
      mdText = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8')
    } catch {
      console.warn('[dsh-tool-nanobot] SKILL.md not found; nanobot-run skill not registered')
    }
    if (mdText !== null) {
      const fm = (mdText.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
      // Minimal YAML reader for the frontmatter's folded scalars ("->-"/"|-").
      // Lines inside a folded block are joined with a space; literal blocks
      // keep their line breaks. Unknown keys are ignored.
      const folded = (key) => {
        const lines = fm.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(new RegExp('^' + key + '(:\\s*(>-?|\\|-?)\\s*)$'))
          if (!m) continue
          const parts = []
          i++
          while (i < lines.length && /^\s+\S/.test(lines[i])) {
            parts.push(lines[i].trim())
            i++
          }
          return m[2].charAt(0) === '>' ? parts.join(' ') : parts.join('\n')
        }
        return ''
      }
      const version = (fm.match(/^\s*version:\s*([^\s]+)/m) || [])[1] || '0.0.0'
      const description = folded('description')
      const whenToUse = folded('whenToUse')
      if (!description || !whenToUse) {
        console.warn('[dsh-tool-nanobot] SKILL.md frontmatter missing description/whenToUse; nanobot-run skill not registered')
      } else {
        skills.register({
          name: 'nanobot-run',
          description,
          content: mdText.replace(/^---[\s\S]*?---\s*/, '').trim(),
          whenToUse,
          metadata: {
            name: 'nanobot-run',
            version,
            plugin: 'dsh-tool-nanobot',
            repo: 'https://github.com/2025Bigeye/dsh-nanobot-subagent-link',
          },
        })
      }
    }
  } else {
    console.warn('[dsh-tool-nanobot] skills service unavailable; nanobot-run skill not registered')
  }
}

export default { name, apply, inject }
