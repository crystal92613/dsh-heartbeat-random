/**
 * dsh-heartbeat-random v0.6.0
 *
 * 多目标心跳：每个目标 = 主会话 + 内心会话对，各自有独立的节律（间隔/时间窗/空闲限制/每日上限）。
 * 全局计时器每 tickSeconds 醒来一次，只评估"到点且不在冷却"的目标。
 */
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { registerHeartbeatRoutes } from './routes.js'

export const name = 'dsh-heartbeat-random'
export const inject = ['agents', 'tools', 'webServer']

const DEFAULT_BEHAVIORS = [
  { id: 'chat', weight: 2 },
  { id: 'browse', weight: 1 },
  { id: 'tidy', weight: 1 },
  { id: 'idle', weight: 6 },
]

const DEFAULT_TARGET = {
  name: '默认',
  targetCwd: '',
  targetSessionId: '',
  innerSessionId: 'heartbeat-inner',
  innerCwd: '',
  enabled: true,
  intervalSeconds: 1800,
  onlyWhenIdle: true,
  maxWakesPerDay: 3,
  days: [1, 2, 3, 4, 5, 6, 7],
  windows: [{ from: '00:00', to: '24:00' }],
  maxContinueRounds: 5,
  allowReport: true,
  allowPeek: true,
  defaultBehaviors: DEFAULT_BEHAVIORS,
  behaviors: [],
  suppressHint: "考虑成本（token、时间）、有没有新信息，自己决定要不要继续。",
}

const DEFAULTS = {
  enabled: true,
  tickSeconds: 60,
  hideArchivedSessions: true,
  innerProvider: 'deepseek-account',
  innerModel: 'deepseek-flash',
  mainProvider: 'deepseek-account',
  mainModel: 'deepseek-flash',
  decideTimeoutMs: 180000,
  targets: [DEFAULT_TARGET],
  wakePrompt: "[心跳] 你在内心会话里，先别做实际操作。\n当前时间：{{time}}。\n你可以选择：主动找他做点什么，或者什么都不做（沉默很正常）。\n可选行为：\n{{behaviors}}\n想好后调用 heartbeat_decide 工具：behavior 填行为 id，reason 写一句理由。\n不要输出别的内容，也不要调用其它工具。",
  continuePrompt: "[心跳·续做] 主会话做完了，想跟你说：\n{{text}}\n\n客观情况：\n- 这是本次心跳的第 {{round}} 轮续做（上限 {{cap}} 轮）\n- 距离本次心跳开始已过 {{elapsed}} 分钟\n- 主会话当前 {{status}}\n\n{{hint}}\n决定后调用 heartbeat_continue：allow=true 表示允许继续，instruction 写你希望它继续做的具体指示。",
}

function pad(n) { return String(n).padStart(2, '0') }

function minuteOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''))
  if (m === null) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (h === 24 && mi === 0) return 1440
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function inWindows(now, windows) {
  const mins = now.getHours() * 60 + now.getMinutes()
  for (const w of windows ?? []) {
    const from = minuteOf(w?.from); const to = minuteOf(w?.to)
    if (from === null || to === null) continue
    if (from <= to) { if (mins >= from && mins < to) return true }
    else if (mins >= from || mins < to) return true
  }
  return false
}

function windowStartFor(now, windows) {
  const mins = now.getHours() * 60 + now.getMinutes()
  for (const w of windows ?? []) {
    const from = minuteOf(w?.from); const to = minuteOf(w?.to)
    if (from === null || to === null) continue
    let inside
    if (from <= to) inside = mins >= from && mins < to
    else inside = mins >= from || mins < to
    if (!inside) continue
    const start = new Date(now)
    if (from <= to) {
      start.setHours(Math.floor(from / 60), from % 60, 0, 0)
    } else if (mins >= from) {
      start.setHours(Math.floor(from / 60), from % 60, 0, 0)
    } else {
      start.setDate(start.getDate() - 1)
      start.setHours(Math.floor(from / 60), from % 60, 0, 0)
    }
    return start.getTime()
  }
  return null
}

/** ISO 周几：周一=1 … 周日=7。 */
function dayAllowed(date, days) {
  const iso = date.getDay() === 0 ? 7 : date.getDay()
  return (days ?? [1, 2, 3, 4, 5, 6, 7]).includes(iso)
}

/** ISO 周几：周一=1 … 周日=7。 */
function isoOf(date) {
  const d = date.getDay()
  return d === 0 ? 7 : d
}

/** 取某天的限制时间列表；缺失/空数组 = 该天不限制。 */
function dayWindowsOf(target, iso) {
  const map = target.dayWindows ?? {}
  const w = map[iso] ?? map[String(iso)]
  return Array.isArray(w) ? w : []
}

/** 当天的间隔秒数；0 或缺省表示沿用目标级 intervalSeconds。 */
function intervalFor(target, now) {
  const map = target.dayIntervalSeconds ?? {}
  const v = Number(map[isoOf(now)] ?? map[String(isoOf(now))])
  if (Number.isFinite(v) && v > 0) return v
  return Number(target.intervalSeconds) > 0 ? Number(target.intervalSeconds) : DEFAULT_TARGET.intervalSeconds
}

/** 当前时刻是否落在当天的限制时间里。 */
function isBlocked(now, target) {
  return inWindows(now, dayWindowsOf(target, isoOf(now)))
}

/** 当前"可跑段"的起点：当天 0 点与最近一次限制窗口结束时刻里较大的那个。 */
function allowedStartFor(now, target) {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  let best = dayStart.getTime()

  const shift = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d }

  const consider = (ws, dayOffset) => {
    for (const w of ws ?? []) {
      const from = minuteOf(w?.from); const to = minuteOf(w?.to)
      if (to === null) continue
      const cross = from !== null && from > to
      const end = shift(now, cross ? dayOffset + 1 : dayOffset)
      end.setHours(Math.floor(to / 60), to % 60, 0, 0)
      if (end.getTime() > now.getTime()) continue
      if (end.getTime() > best) best = end.getTime()
    }
  }

  consider(dayWindowsOf(target, isoOf(now)), 0)
  // 昨天跨零点的窗口，今天凌晨才结束
  consider(dayWindowsOf(target, isoOf(shift(now, -1))).filter((w) => {
    const from = minuteOf(w?.from); const to = minuteOf(w?.to)
    return from !== null && to !== null && from > to
  }), -1)

  return best
}

/** 旧版白名单配置 → 黑名单：补齐剩余星期与剩余时段。 */
function migrateWhitelistTarget(t) {
  const days = Array.isArray(t?.days) ? t.days.map(Number) : [1, 2, 3, 4, 5, 6, 7]
  const disabledDays = [1, 2, 3, 4, 5, 6, 7].filter((d) => !days.includes(d))
  const ws = Array.isArray(t?.windows) ? t.windows : []
  const disabled = []
  let cursor = 0
  const sorted = ws.map((w) => ({ from: minuteOf(w?.from), to: minuteOf(w?.to) }))
    .filter((w) => w.from !== null && w.to !== null && w.from < w.to)
    .sort((a, b) => a.from - b.from)
  for (const w of sorted) {
    if (w.from > cursor) disabled.push({ from: fmt(cursor), to: fmt(w.from) })
    cursor = Math.max(cursor, w.to)
  }
  if (cursor < 1440) disabled.push({ from: fmt(cursor), to: '24:00' })
  return { disabledDays, disabledWindows: disabled }
}

function fmt(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0')
}

function renderTemplate(template, vars) {
  let out = String(template ?? '')
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll('{{' + key + '}}', String(value))
  return out
}

function userMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

async function attachToWorkspace(ctx, sessionId, dstCwd, log) {
  try {
    const list = ctx.workspaces?.list?.() ?? []
    const arr = Array.isArray(list) ? list : [...(list?.values?.() ?? [])]
    const ws = arr.find((w) => String(w?.path ?? '').toLowerCase() === String(dstCwd).toLowerCase())
    if (ws !== undefined && typeof ws.attachSession === 'function') {
      await ws.attachSession(sessionId)
      log({ type: 'attached', via: 'service', sessionId, cwd: dstCwd })
      return true
    }
  } catch (error) {
    log({ type: 'attach-service-failed', error: String(error?.message ?? error) })
  }
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(home, 'storages', 'workspace.json')
    if (!existsSync(file)) return false
    const data = JSON.parse(readFileSync(file, 'utf8'))
    let changed = false
    for (const ws of Object.values(data?.tables?.workspaces ?? {})) {
      if (String(ws?.path ?? '').toLowerCase() !== String(dstCwd).toLowerCase()) continue
      ws.sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
      if (!ws.sessionIds.includes(sessionId)) { ws.sessionIds.push(sessionId); changed = true }
      break
    }
    if (!changed) return false
    copyFileSync(file, file + '.bak-heartbeat-' + Date.now())
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
    log({ type: 'attached', via: 'file', sessionId, cwd: dstCwd })
    return true
  } catch (error) {
    log({ type: 'attach-failed', error: String(error?.message ?? error) })
    return false
  }
}

function normalizeBehaviors(list) {
  const arr = Array.isArray(list) && list.length > 0 ? list : DEFAULT_BEHAVIORS
  return arr.map((b, i) => ({
    id: String(b?.id ?? `行为${i + 1}`),
    weight: Number.isFinite(Number(b?.weight)) ? Number(b.weight) : 1,
    wake: b?.wake !== false && b?.skip !== true,
    ...(typeof b?.prompt === 'string' && b.prompt.length > 0 ? { prompt: b.prompt } : {}),
  }))
}

function normalizeDayWindows(t) {
  if (t?.dayWindows && typeof t.dayWindows === 'object') {
    const out = {}
    for (let d = 1; d <= 7; d++) {
      const w = t.dayWindows[d] ?? t.dayWindows[String(d)]
      out[d] = Array.isArray(w) ? w : []
    }
    return out
  }
  // 旧配置迁移：days 是"限制日"，windows 是"限制时间"
  const days = Array.isArray(t?.days) ? t.days.map(Number) : [1, 2, 3, 4, 5, 6, 7]
  const ws = Array.isArray(t?.windows) ? t.windows : []
  const out = {}
  for (let d = 1; d <= 7; d++) {
    out[d] = days.length === 0 || days.includes(d) ? ws : []
  }
  return out
}

function normalizeDayIntervals(t) {
  const map = t?.dayIntervalSeconds ?? {}
  const out = {}
  for (let d = 1; d <= 7; d++) {
    const v = Number(map[d] ?? map[String(d)])
    out[d] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  }
  return out
}

function normalizeTargets(cfg) {
  const list = Array.isArray(cfg.targets) && cfg.targets.length > 0 ? cfg.targets : [DEFAULT_TARGET]
  return list.map((t, i) => ({
    name: String(t?.name ?? `目标 ${i + 1}`),
    targetCwd: String(t?.targetCwd ?? DEFAULT_TARGET.targetCwd),
    targetSessionId: String(t?.targetSessionId ?? ''),
    innerSessionId: String(t?.innerSessionId ?? 'heartbeat-inner'),
    innerCwd: String(t?.innerCwd ?? t?.targetCwd ?? DEFAULT_TARGET.innerCwd),
    enabled: t?.enabled !== false,
    intervalSeconds: Number(t?.intervalSeconds) > 0 ? Number(t.intervalSeconds) : DEFAULT_TARGET.intervalSeconds,
    dayWindows: normalizeDayWindows(t),
    dayIntervalSeconds: normalizeDayIntervals(t),
    windows: Array.isArray(t?.windows) ? t.windows : [],
    onlyWhenIdle: t?.onlyWhenIdle !== false,
    maxWakesPerDay: Number.isFinite(Number(t?.maxWakesPerDay)) ? Number(t.maxWakesPerDay) : DEFAULT_TARGET.maxWakesPerDay,
    days: Array.isArray(t?.days) ? t.days.map((d) => Number(d)).filter((d) => d >= 1 && d <= 7) : DEFAULT_TARGET.days,
    maxContinueRounds: Number.isFinite(Number(t?.maxContinueRounds)) ? Number(t.maxContinueRounds) : DEFAULT_TARGET.maxContinueRounds,
    allowReport: t?.allowReport !== false,
    allowPeek: t?.allowPeek !== false,
    defaultBehaviors: normalizeBehaviors(t?.defaultBehaviors ?? []),
    behaviors: normalizeBehaviors(t?.behaviors ?? cfg.behaviors ?? []),
    innerProvider: String(t?.innerProvider ?? cfg.innerProvider ?? 'deepseek-account'),
    innerModel: String(t?.innerModel ?? cfg.innerModel ?? 'deepseek-flash'),
    mainProvider: String(t?.mainProvider ?? cfg.mainProvider ?? cfg.innerProvider ?? 'deepseek-account'),
    mainModel: String(t?.mainModel ?? cfg.mainModel ?? cfg.innerModel ?? 'deepseek-flash'),
    decideTimeoutMs: Number.isFinite(Number(t?.decideTimeoutMs)) ? Number(t.decideTimeoutMs) : (Number(cfg.decideTimeoutMs) || 180000),
    wakePrompt: typeof t?.wakePrompt === 'string' && t.wakePrompt.length > 0 ? t.wakePrompt : cfg.wakePrompt,
    continuePrompt: typeof t?.continuePrompt === 'string' && t.continuePrompt.length > 0 ? t.continuePrompt : cfg.continuePrompt,
    suppressHint: (() => {
      if (typeof t?.suppressHint === 'string' && t.suppressHint.length > 0) return t.suppressHint
      if (typeof t?.suppressPrompt === 'string' && t.suppressPrompt.length > 0) {
        const line = t.suppressPrompt.split('\n').find((l) => l.includes('考虑成本') || l.includes('自己决定'))
        if (line !== undefined) return line.trim()
      }
      return DEFAULT_TARGET.suppressHint
    })(),
  }))
}

export const __test = { inWindows, windowStartFor, dayAllowed, minuteOf, isBlocked, allowedStartFor, migrateWhitelistTarget }

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.('dsh-heartbeat-random')
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(home, 'storages', 'heartbeat-random')
  const cfgFile = join(stateDir, 'config.json')
  const eventsFile = join(stateDir, 'events.jsonl')
  const stateFile = join(stateDir, 'state.json')

  const readFileCfg = () => { try { return JSON.parse(readFileSync(cfgFile, 'utf8')) } catch { return {} } }
  let cfg = { ...DEFAULTS, ...(config ?? {}), ...readFileCfg() }
  cfg.targets = normalizeTargets(cfg)

  if (cfg.scheduleMode !== 'blacklist') {
    cfg.targets = cfg.targets.map((t) => {
      const legacy = migrateWhitelistTarget(t)
      return { ...t, days: legacy.disabledDays, windows: legacy.disabledWindows }
    })
    cfg.scheduleMode = 'blacklist'
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(cfgFile, JSON.stringify({ ...cfg }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }

  const ensureDir = () => { try { mkdirSync(stateDir, { recursive: true }) } catch { /* ignore */ } }
  const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return { byTarget: {} } } }
  const writeState = (s) => { try { ensureDir(); writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8') } catch { /* ignore */ } }
  const log = (event) => { try { ensureDir(); appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8') } catch { /* ignore */ } }

  // 旧版本把事件写在 <工作区>\.heartbeat\events.jsonl，第一次升级时搬过来
  try {
    if (!existsSync(eventsFile)) {
      for (const t of cfg.targets) {
        const legacy = join(t.targetCwd, '.heartbeat', 'events.jsonl')
        if (existsSync(legacy)) {
          ensureDir()
          appendFileSync(eventsFile, readFileSync(legacy, 'utf8'), 'utf8')
          log({ type: 'events-migrated', from: legacy })
          break
        }
      }
    }
  } catch { /* ignore */ }

  // MIGRATE_BEHAVIORS：旧配置的全局 behaviors 分发给每个目标后落盘一次
  try {
    const fileCfg = readFileCfg()
    const fileTargets = Array.isArray(fileCfg.targets) ? fileCfg.targets : []
    const legacy = Array.isArray(fileCfg.behaviors) ? fileCfg.behaviors : null
    const needs = fileTargets.length > 0 && fileTargets.some((t) => !Array.isArray(t.behaviors) || typeof t.wakePrompt !== 'string' || typeof t.continuePrompt !== 'string')
    if (needs) {
      const seeded = {
        ...cfg,
        targets: cfg.targets.map((t) => ({
          ...t,
          behaviors: t.behaviors ?? normalizeBehaviors(legacy ?? (cfg.behaviors ?? DEFAULT_BEHAVIORS)),
          innerProvider: t.innerProvider ?? cfg.innerProvider,
          innerModel: t.innerModel ?? cfg.innerModel,
          mainProvider: t.mainProvider ?? cfg.mainProvider,
          mainModel: t.mainModel ?? cfg.mainModel,
          decideTimeoutMs: t.decideTimeoutMs ?? cfg.decideTimeoutMs,
          wakePrompt: t.wakePrompt ?? cfg.wakePrompt,
          continuePrompt: t.continuePrompt ?? cfg.continuePrompt,
        })),
      }
      for (const dead of ["intervalSeconds","windows","onlyWhenIdle","targetSessionId","dryRun","maxWakesPerDay","behaviors","wakePrompt","continuePrompt","suppressHint","innerProvider","innerModel","mainProvider","mainModel","decideTimeoutMs"]) delete seeded[dead]
      mkdirSync(dirname(cfgFile), { recursive: true })
      writeFileSync(cfgFile, JSON.stringify(seeded, null, 2), 'utf8')
    }
  } catch { /* ignore */ }

  const saveConfig = (next) => {
    const merged = { ...DEFAULTS, ...(config ?? {}), ...(next ?? {}) }
    merged.targets = normalizeTargets(merged)
    for (const dead of ["intervalSeconds","windows","onlyWhenIdle","targetSessionId","dryRun","maxWakesPerDay","behaviors","wakePrompt","continuePrompt","suppressHint"]) delete merged[dead]
    try { mkdirSync(dirname(cfgFile), { recursive: true }); writeFileSync(cfgFile, JSON.stringify(merged, null, 2), 'utf8') } catch { /* ignore */ }
    cfg = merged
    return cfg
  }

  let pending = null
  let pendingContinue = null
  let pendingBehaviors = null
  let activeCycle = null

  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

  const readTailMessages = (sessionId, limit) => {
    try {
      const root = join(home, 'sessions')
      let file = null
      for (const ws of readdirSync(root)) {
        const p = join(root, ws, sessionId, 'session.v4.jsonl.zstd')
        if (existsSync(p)) { file = p; break }
      }
      if (file === null) return []
      const raw = readFileSync(file)
      const offs = []
      let i = raw.indexOf(MAGIC, 0)
      while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }
      let text = ''
      for (let k = 0; k < offs.length; k += 1) {
        const end = k + 1 < offs.length ? offs[k + 1] : raw.length
        try { text += zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') + '\n' } catch { /* ignore */ }
      }
      const out = []
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e.type !== 'assistant/message' && e.type !== 'user/message') continue
        const content = e.data?.message?.content ?? []
        const body = content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('').trim()
        if (body === '') continue
        out.push((e.type === 'assistant/message' ? '主会话: ' : '用户: ') + body.slice(0, 1200))
      }
      return out.slice(-Math.max(1, Math.min(40, limit)))
    } catch (error) {
      log({ type: 'peek-failed', error: String(error?.message ?? error) })
      return []
    }
  }

  const listAgents = () => {
    try {
      const l = ctx.agents?.list?.() ?? []
      return Array.isArray(l) ? l : [...(l?.values?.() ?? [])]
    } catch { return [] }
  }

  const findAgent = (sessionId, cwd) => {
    const arr = listAgents()
    const matches = arr.filter((a) => {
      if (sessionId) return String(a?.session?.id ?? '') === String(sessionId)
      const c = String(a?.session?.header?.cwd ?? a?.session?.cwd ?? '')
      return c.toLowerCase() === String(cwd).toLowerCase()
    })
    return matches[matches.length - 1]
  }

  // [preset-fix] resume/create 的空 setup 会让会话落到"空预设层"：只剩插件工具、
  // 缺 read/write/read_image/pwsh 等核心工具（实测 tools=51）。这里把标准预设挂上。
  const mountPresetSetup = () => {
    try {
      const presets = ctx.get?.('agentPresets')
      if (presets === undefined || typeof presets.mount !== 'function') return async () => {}
      return async (agentCtx) => {
        try { await presets.mount(agentCtx, 'standard') } catch (err) {
          log({ type: 'preset-mount-failed', error: String(err?.message ?? err) })
        }
      }
    } catch { return async () => {} }
  }

  const ensureAgent = async (sessionId, cwd, kind, models) => {
    const found = findAgent(sessionId, sessionId ? null : cwd)
    if (found !== undefined) return found
    const agentOptions = models ?? { provider: cfg.innerProvider, model: cfg.innerModel }
    if (typeof ctx.agents?.resume === 'function' && sessionId) {
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup: mountPresetSetup() })
        const agent = handle?.agent ?? handle
        if (agent !== undefined) { log({ type: kind === 'inner' ? 'inner-resumed' : 'main-resumed', sessionId }); return agent }
      } catch (error) {
        log({ type: kind === 'inner' ? 'inner-resume-failed' : 'main-resume-failed', sessionId, error: String(error?.message ?? error) })
      }
    }
    if (kind === 'inner' && typeof ctx.agents?.create === 'function' && sessionId) {
      const handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup: mountPresetSetup() })
      const agent = handle?.agent ?? handle
      if (agent === undefined) throw new Error('agents.create 返回里没有 agent')
      log({ type: 'inner-created', sessionId })
      await attachToWorkspace(ctx, sessionId, cwd, log)
      return agent
    }
    return undefined
  }

  const waitContinue = (timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingContinue = null; reject(new Error('内心会话超时未给出决定')) }, timeoutMs)
    pendingContinue = { resolve, timer }
  })

  const waitDecision = (timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = null; reject(new Error('内心会话超时未给出决定')) }, timeoutMs)
    pending = { resolve, timer }
  })

  const runTarget = async (target, now) => {
    const tag = target.name || target.innerSessionId
    const behaviors = [...(target.defaultBehaviors ?? []), ...(target.behaviors ?? [])]
    const main = await ensureAgent(target.targetSessionId, target.targetCwd, 'main', { provider: target.mainProvider, model: target.mainModel })
    if (main === undefined) { log({ type: 'skip', reason: 'main-agent-missing', target: tag }); return { target: tag, skipped: 'main-agent-missing', judged: false, woke: false } }
    if (target.onlyWhenIdle !== false && String(main.status) !== 'idle') { log({ type: 'skip', reason: 'main-busy', target: tag }); return { target: tag, skipped: 'main-busy', judged: false, woke: false } }

    let inner
    try { let innerId = String(target.innerSessionId ?? '')
      if (innerId === '' || innerId === 'auto') {
        innerId = 'heartbeat-inner-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        target.innerSessionId = innerId
        try {
          const persisted = { ...cfg, targets: cfg.targets.map((t) => (t === target ? { ...t, innerSessionId: innerId } : t)) }
          mkdirSync(dirname(cfgFile), { recursive: true })
          writeFileSync(cfgFile, JSON.stringify(persisted, null, 2), 'utf8')
        } catch { /* ignore */ }
      }
      inner = await ensureAgent(innerId, target.innerCwd, 'inner', { provider: target.innerProvider, model: target.innerModel }) } catch (error) {
      log({ type: 'inner-unavailable', target: tag, error: String(error?.message ?? error) })
      return { target: tag, error: 'inner-unavailable', detail: String(error?.message ?? error), judged: false, woke: false }
    }
    if (inner === undefined) { log({ type: 'inner-unavailable', target: tag, error: '找不到内心会话' }); return { target: tag, error: 'inner-unavailable', judged: false, woke: false } }
    if (target.onlyWhenIdle !== false && String(inner.status) !== 'idle') { log({ type: 'skip', reason: 'inner-busy', target: tag }); return { target: tag, skipped: 'inner-busy', judged: false, woke: false } }

    const behaviorLines = behaviors.map((b) => `- ${b.id}（权重 ${b.weight}）` + (b.prompt ? `：${b.prompt}` : '')).join('\n')
    const prompt = renderTemplate(target.wakePrompt ?? cfg.wakePrompt, { time: now.toLocaleString('zh-CN'), behaviors: behaviorLines })

    let decision
    try {
      pendingBehaviors = behaviors
      const waiting = waitDecision(Number(target.decideTimeoutMs) || 180000)
      inner.followup(userMessage(prompt))
      decision = await waiting
    } catch (error) {
      log({ type: 'decision-timeout', target: tag, error: String(error?.message ?? error) })
      return { target: tag, error: 'decision-timeout', judged: true, woke: false }
    }

    const behavior = behaviors.find((b) => b.id === decision.behavior)
    if (behavior === undefined) {
      log({ type: 'unknown-behavior', target: tag, behavior: String(decision.behavior ?? '') })
      return { target: tag, decided: 'idle', reason: 'unknown-behavior', judged: true }
    }
    if (behavior.wake === false) {
      log({ type: 'decided-skip', target: tag, behavior: behavior.id })
      return { target: tag, decided: 'idle', judged: true, woke: false }
    }
    const action = behavior.prompt ? behavior.prompt : `按「${behavior.id}」这个名字的含义，自己决定具体做什么。`
    main.followup(userMessage(`[心跳] 你醒了（${now.toLocaleString('zh-CN')}）。这次决定做：${behavior.id}。${action}`))
    activeCycle = { target, main, round: 0, startedAt: Date.now() }
    log({ type: 'woke-main', target: tag, behavior: behavior.id })
    return { target: tag, decided: behavior.id, judged: true, woke: true }
  }

  const runOnce = async (manual) => {
    cfg = { ...DEFAULTS, ...(config ?? {}), ...readFileCfg() }
    cfg.targets = normalizeTargets(cfg)
    if (!manual && cfg.enabled === false) return { skipped: 'disabled' }

    const now = new Date()
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const state = readState()
    state.byTarget = state.byTarget ?? {}

    const results = []
    for (const target of cfg.targets) {
      if (target.enabled === false) continue
      const key = target.name
      const st = state.byTarget[key] ?? { day: '', wakes: 0, lastAt: 0 }
      if (st.day !== day) { st.day = day; st.wakes = 0 }

      if (!manual) {
        if (isBlocked(now, target)) continue
        if (Number(target.maxWakesPerDay) >= 0 && Number(st.wakes) >= Number(target.maxWakesPerDay)) continue
        const allowStart = allowedStartFor(now, target)
        const boundary = Number(st.lastAt) < allowStart
        if (!boundary && now.getTime() - Number(st.lastAt) < intervalFor(target, now) * 1000) continue
      }

      const r = await runTarget(target, now)
      if (r.judged) st.lastAt = now.getTime()
      if (r.woke) st.wakes = Number(st.wakes) + 1
      state.byTarget[key] = st
      writeState(state)
      results.push(r)
    }
    return { results }
  }

  const getLive = () => {
    const out = {}
    for (const a of listAgents()) {
      const id = a?.session?.id
      if (typeof id === 'string' && id.length > 0) out[id] = { live: true, status: String(a.status ?? '') }
    }
    return out
  }

  const getStatus = () => {
    const st = readState()
    return {
      enabled: cfg.enabled,
      tickSeconds: cfg.tickSeconds,
      targets: cfg.targets.map((t) => {
        const m = findAgent(t.targetSessionId, t.targetCwd)
        const i = findAgent(t.innerSessionId, null)
        const s = (st.byTarget ?? {})[t.name] ?? null
        return {
          name: t.name, enabled: t.enabled,
          targetCwd: t.targetCwd, targetSessionId: t.targetSessionId,
          innerCwd: t.innerCwd, innerSessionId: t.innerSessionId,
          intervalSeconds: t.intervalSeconds, dayIntervalSeconds: t.dayIntervalSeconds, dayWindows: t.dayWindows,
          onlyWhenIdle: t.onlyWhenIdle, maxWakesPerDay: t.maxWakesPerDay,
          mainLive: m !== undefined, mainStatus: m?.status ?? null,
          innerLive: i !== undefined, innerStatus: i?.status ?? null,
          wakesToday: s?.wakes ?? 0, lastAt: s?.lastAt ?? 0, blocked: isBlocked(new Date(), t),
        }
      }),
      configFile: cfgFile,
    }
  }

  ctx.effect(() => registerHeartbeatRoutes(ctx, { logger, getStatus, getConfig: () => cfg, saveConfig, eventsFile, home, getLive }), 'heartbeat-random: routes')

  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'heartbeat_decide',
    description: '心跳内心会话专用：报告这次心跳的决定。wake=true 表示要在主会话里执行某个行为。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        behavior: { type: 'string', description: '行为 id（必须是当前行为池里的名字）。' },
        reason: { type: 'string', description: '一句话理由。' },
      },
      required: ['behavior'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
    async execute(args) {
      if (pending === null) return '没有正在等待的心跳判断。'
      const wake = args?.wake === true
      const behavior = String(args?.behavior ?? '')
      const ids = (pendingBehaviors ?? []).map((b) => b.id)

      // 行为名不在池里：按沉默处理，并把可选项回给内心，方便下次纠正
      if (wake && !ids.includes(behavior)) {
        return `行为名「${behavior}」不在当前行为池里（可选：${ids.join(' / ') || '无'}）。这次不算数，请用池里的 id 重新调用。`
      }

      const { resolve, timer } = pending
      pending = null
      clearTimeout(timer)
      resolve({ behavior, reason: String(args?.reason ?? '') })
      return '收到。'
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'heartbeat_report',
    description: '心跳主会话用：做完之后如果还有想继续的事，把"做了什么、还想做什么、为什么"用你自己的话告诉内心会话。格式自由。只有你确实需要时才调用。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', description: '想对内心会话说的话（自由格式）。' } },
      required: ['text'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
    async execute(args) {
      const text = String(args?.text ?? '').trim()
      if (text === '') return '内容为空，没有转达。'
      const cycle = activeCycle
      if (cycle === null) return '当前没有正在进行的心跳周期。'
      if (cycle.target.allowReport === false) return '这个目标没有开启"主会话续做请求"。'
      const rawCap = Number(cycle.target.maxContinueRounds)
      const cap = Number.isFinite(rawCap) ? rawCap : 5
      const unlimited = cap < 0
      const capLabel = unlimited ? '不限' : String(cap)
      if (!unlimited && cycle.round >= cap) { activeCycle = null; return '续做轮数已达上限。' }
      const inner = findAgent(cycle.target.innerSessionId, null)
      if (inner === undefined) return '内心会话没活着，无法转达。'
      if (String(inner.status) !== 'idle') return '内心会话正忙，等它空闲再说。'

      const round = cycle.round + 1
      const elapsed = Math.max(0, Math.round((Date.now() - cycle.startedAt) / 60000))
      const hint = String(cycle.target.suppressHint || cfg.suppressHint || "考虑成本（token、时间）、有没有新信息，自己决定要不要继续。")
      const prompt = renderTemplate(cycle.target.continuePrompt ?? cfg.continuePrompt, {
        text,
        round: String(round),
        cap: capLabel,
        elapsed: String(elapsed),
        status: String(inner.status),
        hint,
      })

      let decision
      try {
        pendingContinue = null
        const waiting = waitContinue(Number(cycle.target.decideTimeoutMs) || 180000)
        inner.followup(userMessage(prompt))
        decision = await waiting
      } catch (error) {
        log({ type: 'continue-timeout', target: cycle.target.name, error: String(error?.message ?? error) })
        activeCycle = null
        return '内心会话没有在时限内回应，这次结束。'
      }

      if (decision.allow !== true) {
        log({ type: 'continue-rejected', target: cycle.target.name, round })
        activeCycle = null
        return '内心会话决定停下。'
      }
      cycle.round = round
      const instruction = String(decision.instruction ?? '').trim() || '继续按你觉得有价值的方向做。'
      cycle.main.followup(userMessage(`[心跳·续做 第 ${round} 轮] ${instruction}`))
      log({ type: 'continue-granted', target: cycle.target.name, round })
      return `内心会话同意继续（第 ${round} 轮）。`
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'heartbeat_continue',
    description: '心跳内心会话用：主会话请求续做时，回答是否允许继续，并给出具体指示。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        allow: { type: 'boolean', description: '是否允许继续。' },
        instruction: { type: 'string', description: '允许时，写希望它继续做的具体指示。' },
      },
      required: ['allow'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
    async execute(args) {
      if (pendingContinue === null) return '没有正在等待的续做判断。'
      const { resolve, timer } = pendingContinue
      pendingContinue = null
      clearTimeout(timer)
      resolve({ allow: args?.allow === true, instruction: String(args?.instruction ?? '') })
      return '收到。'
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'heartbeat_peek',
    description: '心跳内心会话用：读主会话最近的对话原文（当你觉得对方转达的信息不够、需要看细节时）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'number', description: '看最近多少条，默认 10，最多 40。' } },
      required: [],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
    async execute(args) {
      const target = activeCycle?.target ?? (cfg.targets && cfg.targets[0])
      if (target === undefined) return '没有可读的目标会话。'
      if (target.allowPeek === false) return '这个目标没有开启"内心会话决策参考"。'
      const lines = readTailMessages(target.targetSessionId, Number(args?.limit ?? 10))
      return lines.length === 0 ? '没读到消息。' : lines.join('\n\n')
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'heartbeat_behaviors',
    description: '管理当前目标的行为池：查看 / 新增 / 修改 / 删除。可改行为名、权重、提示词。只在需要调整"醒来后能做什么"时使用。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: '操作类型' },
        id: { type: 'string', description: '已有行为名（update/remove 用）' },
        newId: { type: 'string', description: '改名后的行为名（update 用，可选）' },
        weight: { type: 'number', description: '权重（add/update 用）' },
        prompt: { type: 'string', description: '提示词（add/update 用，可空）' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
    async execute(args) {
      const action = String(args?.action ?? '')
      const target = activeCycle?.target ?? cfg.targets?.[0]
      if (target === undefined) return '没有可编辑的目标。'
      const list = Array.isArray(target.behaviors) ? target.behaviors.map((b) => ({ ...b })) : []

      if (action === 'list') return JSON.stringify(list, null, 2)

      if (action === 'add') {
        const id = String(args?.newId ?? args?.id ?? '').trim()
        if (id === '') return '新增需要行为名（newId 或 id）。'
        if (list.some((b) => b.id === id)) return `行为「${id}」已存在。`
        list.push({
          id,
          weight: Number.isFinite(Number(args?.weight)) ? Number(args.weight) : 1,
          ...(typeof args?.prompt === 'string' && args.prompt.length > 0 ? { prompt: String(args.prompt) } : {}),
        })
      } else if (action === 'update') {
        const idx = list.findIndex((b) => b.id === String(args?.id ?? ''))
        if (idx < 0) return `找不到行为「${args?.id}」。`
        const cur = list[idx]
        if (typeof args?.newId === 'string' && args.newId.trim() !== '') cur.id = args.newId.trim()
        if (Number.isFinite(Number(args?.weight))) cur.weight = Number(args.weight)
        if (typeof args?.prompt === 'string') {
          if (args.prompt.length > 0) cur.prompt = args.prompt
          else delete cur.prompt
        }
        list[idx] = cur
      } else if (action === 'remove') {
        const idx = list.findIndex((b) => b.id === String(args?.id ?? ''))
        if (idx < 0) return `找不到行为「${args?.id}」。`
        list.splice(idx, 1)
        if (list.length === 0) return '至少要保留一个行为。'
      } else {
        return '未知 action，可选：list / add / update / remove。'
      }

      const nextCfg = { ...cfg, targets: cfg.targets.map((t) => (t === target ? { ...t, behaviors: list } : t)) }
      saveConfig(nextCfg)
      return '已更新，当前行为池：\n' + JSON.stringify(list, null, 2)
    },
  }))

  // [approval-gate] 手动触发心跳要审批：其他会话不能悄悄把心跳跑起来。
  // 策略 ask → 走官方 approval.request，只有 allowed-once 才放行；
  // 策略 never → 不追问；读不到策略或服务缺席 → fail-closed（拒绝）。
  const approvalGateFor = async (exec, reason) => {
    let svc
    try { svc = ctx.get?.('approval') } catch { svc = undefined }
    if (svc === undefined || svc === null) return 'REFUSED: 审批服务不可用，未触发心跳（fail-closed）。'
    const agent = exec?.agent
    const session = agent?.session
    let policy
    try { policy = typeof svc.effectivePolicy === 'function' ? svc.effectivePolicy.call(svc, session) : undefined } catch { policy = undefined }
    if (policy === 'never') return true
    if (policy !== 'ask') return 'REFUSED: 读不到审批策略（' + String(policy) + '），未触发心跳（fail-closed）。'
    if (typeof svc.request !== 'function') return 'REFUSED: 审批服务没有 request 方法，未触发心跳。'
    let outcome
    try {
      outcome = await svc.request.call(svc, {
        agent,
        toolName: 'heartbeat_tick',
        reason,
        ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
      })
    } catch (e) {
      outcome = 'unavailable'
    }
    if (outcome === 'allowed-once') return true
    return 'REFUSED: 未获批准，未触发心跳（' + String(outcome) + '）。'
  }

  disposers.push(ctx.tools.register({
    name: 'heartbeat_tick',
    description: '手动触发一次心跳评估（忽略时间窗与间隔），返回每个目标的结果或失败原因。',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
    async execute(_args, exec) {
      const gate = await approvalGateFor(exec, '手动触发一次心跳评估（忽略时间窗与间隔）')
      if (gate !== true) return gate
      try { return JSON.stringify(await runOnce(true), null, 2) } catch (error) { return 'ERROR: ' + String(error?.message ?? error) }
    },
  }))

  ctx.effect(() => {
    const every = Math.max(10, Number(cfg.tickSeconds) || 60)
    const timer = setInterval(() => { void runOnce(false) }, every * 1000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      if (pending !== null) { clearTimeout(pending.timer); pending = null }
      for (const d of disposers) { try { d?.() } catch { /* ignore */ } }
    }
  }, 'heartbeat-random: timer')

  logger?.info?.(`heartbeat-random v0.6.0: ${cfg.targets.length} 个目标，计时器 ${cfg.tickSeconds}s`)
}
