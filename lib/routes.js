/**
 * dsh-heartbeat-random — host HTTP routes.
 * GET  /heartbeat-random/status        → 运行状态 + 配置 + 最近事件
 * GET  /heartbeat-random/config        → 取配置
 * POST /heartbeat-random/config        → 保存配置
 * GET  /heartbeat-random/workspaces    → 工作区 + 会话（含标题）
 * GET  /heartbeat-random/events        → 历史事件（?limit=200）
 * POST /heartbeat-random/open-config   → 在资源管理器里定位配置文件
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { spawn } from 'node:child_process'

export const ROUTE_PREFIX = '/heartbeat-random'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sessionDirCandidates(home, sessionId) {
  const root = join(home, 'sessions')
  const out = []
  try {
    for (const ws of readdirSync(root)) {
      const p = join(root, ws, sessionId)
      if (existsSync(p)) out.push(p)
    }
  } catch { /* ignore */ }
  return out
}

function decompressFrames(raw) {
  const offs = []
  let i = raw.indexOf(MAGIC, 0)
  while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }
  let text = ''
  for (let k = 0; k < offs.length; k += 1) {
    const end = k + 1 < offs.length ? offs[k + 1] : raw.length
    try { text += zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') + '\n' } catch { /* ignore */ }
  }
  return text
}

const sessionMetaCache = new Map()

/**
 * 读一个会话的「有没有内容 + 标题」。
 * 旧实现每次都整包解压整个会话文件（大文件 14MB→70MB 解压，且每会话两次），
 * 打开设置页时会把 Node 主线程卡住。这里：
 *   ① 按 mtime+size 缓存，没变就不重读；
 *   ② 顺序解帧，拿到标题就停，最多解 4MB，避免大文件拖死；
 *   ③ 解到上限仍没标题时按「有内容」处理，避免把正常会话误判成空壳隐藏掉。
 */
function readSessionMeta(home, sessionId) {
  for (const dir of sessionDirCandidates(home, sessionId)) {
    const file = join(dir, 'session.v4.jsonl.zstd')
    let st
    try { st = statSync(file) } catch { continue }
    const cached = sessionMetaCache.get(file)
    if (cached !== undefined && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached

    const meta = { mtimeMs: st.mtimeMs, size: st.size, has: false, title: '' }
    try {
      const raw = readFileSync(file)
      const offs = []
      let i = raw.indexOf(MAGIC, 0)
      while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }
      let outBytes = 0
      let hitLimit = false
      for (let k = 0; k < offs.length; k += 1) {
        const end = k + 1 < offs.length ? offs[k + 1] : raw.length
        let text = ''
        try { text = zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') } catch { continue }
        outBytes += text.length
        if (!meta.has && (text.includes('"type":"user/message"') || text.includes('"type":"assistant/message"') || text.includes('"type":"message"'))) {
          meta.has = true
        }
        if (meta.title === '' && text.includes('"session/title"')) {
          for (const line of text.split('\n')) {
            if (!line.includes('"session/title"')) continue
            try {
              const e = JSON.parse(line)
              if (e.type === 'session/title' && typeof e.data?.title === 'string') meta.title = e.data.title
            } catch { /* ignore */ }
          }
        }
        if (meta.title !== '') break
        if (outBytes > 4_000_000) { hitLimit = true; break }
      }
      if (meta.title === '' && hitLimit) meta.has = true
    } catch { /* ignore */ }
    if (meta.title !== '') meta.has = true
    sessionMetaCache.set(file, meta)
    if (sessionMetaCache.size > 400) {
      for (const key of sessionMetaCache.keys()) {
        sessionMetaCache.delete(key)
        if (sessionMetaCache.size <= 200) break
      }
    }
    return meta
  }
  return { has: false, title: '' }
}

export function registerHeartbeatRoutes(ctx, { logger, getStatus, getConfig, saveConfig, eventsFile, home, getLive }) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') {
    logger?.info?.('无 webServer 服务，跳过心跳设置路由')
    return () => {}
  }

  const tailEvents = (n) => {
    try {
      if (!existsSync(eventsFile)) return []
      const lines = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
      return lines.slice(-n).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
    } catch { return [] }
  }

  let workspaceCache = { at: 0, data: null }

  const listWorkspaces = () => {
    if (workspaceCache.data !== null && Date.now() - workspaceCache.at < 10000) return workspaceCache.data
    const file = join(home, 'storages', 'workspace.json')
    const out = []
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const archived = new Set(data?.global?.archivedSessionIds ?? [])
      const hideArchived = getConfig().hideArchivedSessions !== false
  const hideEmpty = getConfig().hideEmptySessions !== false
      for (const [id, ws] of Object.entries(data?.tables?.workspaces ?? {})) {
        const sessions = (ws.sessionIds ?? [])
          .filter((sid) => !(hideArchived && archived.has(sid)))
          .map((sid) => ({ sid, meta: readSessionMeta(home, sid) }))
          .filter((x) => !hideEmpty || x.meta.has)
          .map((x) => ({ id: x.sid, title: x.meta.title }))
        out.push({ id, title: ws.title ?? '', path: ws.path ?? '', sessions })
      }
    } catch { /* ignore */ }
    workspaceCache = { at: Date.now(), data: out }
    return out
  }

  const handle = async (req, res, pathname, url) => {
    if (pathname === `${ROUTE_PREFIX}/status`) {
      sendJson(res, 200, { ok: true, ...getStatus(), events: tailEvents(200), live: typeof getLive === 'function' ? getLive() : {} })
      return
    }
    if (pathname === `${ROUTE_PREFIX}/config`) {
      if (req.method === 'GET') { sendJson(res, 200, { ok: true, config: getConfig() }); return }
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        try {
          const next = JSON.parse(body)
          saveConfig(next)
          sendJson(res, 200, { ok: true, config: getConfig() })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (pathname === `${ROUTE_PREFIX}/workspaces`) {
      sendJson(res, 200, { ok: true, workspaces: listWorkspaces() })
      return
    }
    if (pathname === `${ROUTE_PREFIX}/events`) {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '200')))
      sendJson(res, 200, { ok: true, events: tailEvents(limit) })
      return
    }
    if (pathname === `${ROUTE_PREFIX}/open-config`) {
      const status = getStatus()
      const file = status.configFile
      try {
        spawn('explorer.exe', [file], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
        sendJson(res, 200, { ok: true, file })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          await handle(req, res, url.pathname, url)
        } catch (error) {
          logger?.error?.('heartbeat 路由异常: ' + String(error?.message ?? error))
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
          else res.destroy()
        }
      })()
    },
  })
}
