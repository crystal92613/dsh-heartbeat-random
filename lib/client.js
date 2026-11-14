// dsh-heartbeat-random — browser half: 设置 → 心跳 page.
window.__ModuleLoader__.load({
  id: 'dsh-heartbeat-random',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var API = '/heartbeat-random'

    function getJson(path) {
      return fetch(API + path, { headers: { 'content-type': 'application/json' } }).then(function (r) { return r.json() })
    }
    function postJson(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    var S = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px 28px', fontSize: '13px', maxWidth: '760px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      subTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      desc: { margin: 0, fontSize: '12px', lineHeight: 1.65, opacity: 0.72 },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { minWidth: '110px', fontSize: '13px', opacity: 0.8 },
      input: { flex: 1, minWidth: '160px', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', font: 'inherit' },
      select: { flex: 1, minWidth: '160px', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #111)', font: 'inherit' },
      area: { width: '100%', minHeight: '72px', padding: '8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', font: 'inherit', fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
      btn: { padding: '7px 14px', borderRadius: '8px', border: '0.5px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      ok: { color: '#2a9d5c' },
      err: { color: '#d33' },
      hint: { fontSize: '12px', lineHeight: 1.7, opacity: 0.66, margin: 0 },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
      badge: { fontSize: '11px', padding: '1px 7px', borderRadius: '999px', border: '1px solid rgba(128,128,128,.4)' },
      tab: { padding: '5px 12px', borderRadius: '999px', border: '1px solid rgba(128,128,128,.35)', cursor: 'pointer', fontSize: '12px', background: 'transparent', color: 'inherit' },
      tabActive: { padding: '5px 12px', borderRadius: '999px', border: '1px solid currentColor', cursor: 'pointer', fontSize: '12px', fontWeight: 600, background: 'transparent', color: 'inherit' },
      events: { maxHeight: '168px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', paddingRight: '4px' },
      evRow: { fontSize: '12px', lineHeight: 1.5, padding: '6px 8px', borderRadius: '6px', background: 'rgba(128,128,128,.10)' },
      divider: { height: '1px', background: 'rgba(128,128,128,.22)', margin: '4px 0' },
    }

    function Row(props) {
      return h('div', { style: S.row }, h('span', { style: S.label }, props.label), props.children)
    }

    function humanize(event) {
      if (!event) return '还没有 tick 过。'
      var at = event.at ? new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''
      var who = event.target ? '[' + event.target + '] ' : ''

      // 统一句式：时间 [目标] 结果，行为「x」，原因/细节
      // 不按行为写文案、不按类型堆分支；未知类型也只输出一句人类可读的话，绝不 dump JSON。
      var kind = String(event.type || 'unknown')
      var head = {
        'woke-main': '已唤醒主会话',
        'decided-idle': '内心选择沉默',
        'decided-skip': '内心选择跳过',
        'decision-timeout': '内心未回应（超时）',
        'unknown-behavior': '行为名无效，未唤醒',
        'skip': '未调度',
        'inner-unavailable': '内心会话不可用',
        'inner-resume-failed': '内心会话恢复失败',
        'main-resume-failed': '主会话恢复失败',
        'inner-created': '内心会话已新建',
        'inner-resumed': '内心会话已恢复',
        'main-resumed': '主会话已恢复',
        'attached': '内心会话已挂到工作区',
        'continue-granted': '允许续做',
        'continue-rejected': '拒绝续做',
        'events-migrated': '旧记录已迁移',
        'error': '程序异常',
      }[kind]
      if (head === undefined) head = '调度事件（' + kind + '）'

      var reasonMap = {
        'out-of-window': '不在允许时段',
        'main-busy': '主会话正在忙',
        'main-agent-missing': '主会话没有活着',
        'inner-busy': '内心会话正在忙',
        'daily-budget': '已达今日上限',
        'unknown-behavior': '行为名不在池里',
      }

      var bits = []
      if (event.behavior) bits.push('行为「' + event.behavior + '」')
      if (event.round) bits.push('第 ' + event.round + ' 轮')
      if (event.reason) bits.push(reasonMap[event.reason] || String(event.reason))
      var detail = event.error || event.message
      if (detail) {
        var text = String(detail).replace(/\s+/g, ' ')
        bits.push(text.length > 80 ? text.slice(0, 80) + '…' : text)
      }
      return at + ' ' + who + head + (bits.length > 0 ? '，' + bits.join('，') : '')
    }

    function parseWindows(text) {
      return String(text || '').split(',').map(function (s) { return s.trim() }).filter(Boolean).map(function (s) {
        var p = s.split('-')
        return { from: (p[0] || '').trim(), to: (p[1] || '').trim() }
      })
    }
    function windowsText(ws) {
      return (ws || []).map(function (w) { return w.from + '-' + w.to }).join(', ')
    }

    function HeartbeatSettings() {
      var cfgState = React.useState(null)
      var cfg = cfgState[0]
      var setCfg = cfgState[1]
      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var spacesState = React.useState([])
      var spaces = spacesState[0]
      var setSpaces = spacesState[1]
      var msgState = React.useState('')
      var msg = msgState[0]
      var setMsg = msgState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var pageState = React.useState(0)
      var page = pageState[0]
      var setPage = pageState[1]
      var dpageState = React.useState(0)
      var bpageState = React.useState(0)
      var dpage = dpageState[0]
      var bpage = bpageState[0]
      var setBpage = bpageState[1]
      var setDpage = dpageState[1]

      function load() {
        getJson('/config').then(function (res) { if (res && res.ok) setCfg(res.config) }).catch(function () {})
        getJson('/status').then(function (res) { if (res && res.ok) setStatus(res) }).catch(function () {})
        getJson('/workspaces').then(function (res) { if (res && res.ok) setSpaces(res.workspaces || []) }).catch(function () {})
      }
      React.useEffect(function () { load() }, [])

      function update(fn) {
        var next = Object.assign({}, cfg)
        next.targets = (next.targets || []).slice().map(function (tt) { return Object.assign({}, tt) })
        fn(next)
        setCfg(next)
      }

      function setTarget(i, key, value) {
        update(function (next) { next.targets[i][key] = value })
      }

      function addTarget() {
        update(function (next) {
          next.targets.push({
            name: '目标 ' + (next.targets.length + 1), targetCwd: '', targetSessionId: '',
            innerSessionId: 'heartbeat-inner', innerCwd: '', enabled: true,
            intervalSeconds: 1800, days: [1, 2, 3, 4, 5, 6, 7], windows: [{ from: '00:00', to: '24:00' }],
            onlyWhenIdle: true, maxWakesPerDay: 3, maxContinueRounds: 5, allowReport: true, allowPeek: true,
            behaviors: [{ id: 'chat', weight: 2 }, { id: 'browse', weight: 1 }, { id: 'tidy', weight: 1 }, { id: 'idle', weight: 6 }],
          })
        })
        setPage((cfg.targets || []).length)
        setBpage(0)
      }

      function removeTarget(i) {
        update(function (next) {
          next.targets.splice(i, 1)
          if (next.targets.length === 0) {
            next.targets.push({
              name: '目标 1', targetCwd: '', targetSessionId: '', innerSessionId: 'heartbeat-inner', innerCwd: '', enabled: true,
              intervalSeconds: 1800, days: [1, 2, 3, 4, 5, 6, 7], windows: [{ from: '00:00', to: '24:00' }],
              onlyWhenIdle: true, maxWakesPerDay: 3, maxContinueRounds: 5, allowReport: true, allowPeek: true,
              behaviors: [{ id: 'chat', weight: 2 }, { id: 'browse', weight: 1 }, { id: 'tidy', weight: 1 }, { id: 'idle', weight: 6 }],
            })
          }
        })
        setPage(function (p) { return Math.max(0, Math.min(p, (cfg.targets || []).length - 2)) })
        setBpage(0)
      }

      function targetDefaults() {
        var tt = (cfg.targets || [])[active] || {}
        return Array.isArray(tt.defaultBehaviors) ? tt.defaultBehaviors : []
      }

      function targetBehaviors() {
        var tt = (cfg.targets || [])[active] || {}
        var defaults = Array.isArray(tt.defaultBehaviors) ? tt.defaultBehaviors : []
        var normal = Array.isArray(tt.behaviors) ? tt.behaviors : []
        return defaults.concat(normal)
      }

      function setBehavior(i, key, value) {
        update(function (next) {
          var dCount = (next.targets[active].defaultBehaviors || []).length
          var which = i < dCount ? 'defaultBehaviors' : 'behaviors'
          var list = (next.targets[active][which] || []).slice()
          var j = i < dCount ? i : i - dCount
          list[j] = Object.assign({}, list[j])
          list[j][key] = value
          next.targets[active][which] = list
        })
      }

      function addBehavior() {
        update(function (next) {
          var list = (next.targets[active].behaviors || []).slice()
          list.push({ id: '行为' + (list.length + 1), weight: 1 })
          next.targets[active].behaviors = list
        })
        setBpage(targetBehaviors().length - 1)
      }

      function removeBehavior(i) {
        var dCount = targetDefaults().length
        if (i < dCount) { setMsg('默认行为无法删除。'); return }
        update(function (next) {
          var list = (next.targets[active].behaviors || []).slice()
          list.splice(i - dCount, 1)
          next.targets[active].behaviors = list
        })
        setBpage(function (p) { return Math.max(0, Math.min(p, targetBehaviors().length - 2)) })
      }

      function save() {
        setBusy(true)
        var payload = Object.assign({}, cfg)
        postJson('/config', payload).then(function (res) {
          if (res && res.ok) { setCfg(res.config); setMsg('已保存，下一轮生效。') }
          else setMsg('保存失败：' + (res && res.error ? res.error : 'unknown'))
          setBusy(false)
        }).catch(function (e) { setMsg('保存失败：' + String(e)); setBusy(false) })
      }

      function openConfig() {
        postJson('/open-config', {}).then(function (res) {
          setMsg(res && res.ok ? '已用系统默认程序打开配置文件。' : '打开失败：' + (res && res.error ? res.error : ''))
        }).catch(function (e) { setMsg('打开失败：' + String(e)) })
      }

      if (cfg === null) return h('div', { style: S.root }, h('p', { style: S.desc }, '加载配置中…'))

      var targets = cfg.targets || []
      var active = Math.max(0, Math.min(page, targets.length - 1))
      var t = targets[active] || {}
      var live = (status && status.live) || {}
      var currentWs = (spaces || []).find(function (w) { return w.path === t.targetCwd }) || null
      var wsSessions = currentWs ? currentWs.sessions || [] : []
      var events = (status && status.events) || []
      var visibleEvents = events.filter(function (e) { return !e.target || e.target === (t.name || '') })
      var behaviors = targetBehaviors()
      var bActive = Math.max(0, Math.min(bpage, behaviors.length - 1))
      var b = behaviors[bActive] || {}

      function liveBadge(sessionId) {
        var st = live[sessionId]
        if (st && st.live) return h('span', { style: Object.assign({}, S.badge, S.ok) }, '在线 · ' + (st.status || 'idle'))
        return h('span', { style: S.badge }, '未启动')
      }

      function pickWorkspace(path) {
        var ws = (spaces || []).find(function (w) { return w.path === path })
        update(function (next) {
          var cur = next.targets[active]
          cur.targetCwd = path
          cur.innerCwd = path
          if (ws && (ws.sessions || []).length > 0) {
            var hasMain = ws.sessions.some(function (s) { return s.id === cur.targetSessionId })
            if (!hasMain) cur.targetSessionId = ws.sessions[0].id
          }
        })
      }

      return h('div', { style: S.root },
        h('h2', { style: S.title }, '心跳'),
        h('p', { style: S.desc }, '按固定间隔在每日时间窗内唤醒一次：先让「内心会话」判断要不要行动、做什么，再把选中的行为注入「主会话」。'),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('h3', { style: Object.assign({}, S.title, { flex: 1, margin: 0 }) }, '内心会话设置'),
            h('button', { style: S.tab, onClick: addTarget }, '＋ 新增内心会话对'),
            h('button', { style: S.tab, onClick: function () { removeTarget(active) } }, '删除这一对')),
          h('div', { style: S.row },
            targets.map(function (tt, i) {
              return h('button', { key: i, style: i === active ? S.tabActive : S.tab, onClick: function () { setPage(i); setBpage(0); setDpage(0) } }, tt.name || ('目标 ' + (i + 1)))
            })),

          h(Row, { label: '名字' }, h('input', { style: S.input, value: t.name || '', onChange: function (e) { setTarget(active, 'name', e.target.value) } })),
          h(Row, { label: '工作区' },
            h('select', { style: S.select, value: t.targetCwd || '', onChange: function (e) { pickWorkspace(e.target.value) } },
              !t.targetCwd ? h('option', { value: '' }, '（选择工作区）') : null,
              (spaces || []).map(function (w) { return h('option', { key: w.id, value: w.path }, w.title + ' — ' + w.path) }))),
          h(Row, { label: '主会话' },
            h('select', { style: S.select, value: t.targetSessionId || '', onChange: function (e) { setTarget(active, 'targetSessionId', e.target.value) } },
              !t.targetSessionId ? h('option', { value: '' }, '（选择主会话）') : null,
              wsSessions.map(function (s) { return h('option', { key: s.id, value: s.id }, (s.title || '(无标题)') + ' — ' + s.id.slice(0, 20)) })),
            liveBadge(t.targetSessionId)),
          h(Row, { label: '内心会话' },
            h('select', { style: S.select, value: t.innerSessionId || '', onChange: function (e) { setTarget(active, 'innerSessionId', e.target.value) } },
              h('option', { value: 'auto' }, '自动新建（唯一 id，不与其他目标冲突）'),
              wsSessions.map(function (s) { return h('option', { key: s.id, value: s.id }, (s.title || '(无标题)') + ' — ' + s.id.slice(0, 20)) })),
            liveBadge(t.innerSessionId)),
          h(Row, { label: '心跳超时（秒）' },
            h('input', { style: S.input, value: t.decideTimeoutMs == null ? 180 : Math.round(t.decideTimeoutMs / 1000), onChange: function (e) { setTarget(active, 'decideTimeoutMs', (Number(e.target.value) || 180) * 1000) } })),
          h('p', { style: S.hint }, '等内心会话给出判断的最长等待；超时按沉默处理。'),
          h(Row, { label: '启用' }, h('input', { type: 'checkbox', checked: t.enabled !== false, onChange: function (e) { setTarget(active, 'enabled', e.target.checked) } })),
          h(Row, { label: '间隔（默认，秒）' }, h('input', { style: S.input, value: t.intervalSeconds, onChange: function (e) { setTarget(active, 'intervalSeconds', Number(e.target.value) || 0) } })),
          h('p', { style: S.hint }, '没有单独设置某天时，用这个间隔；下面是按星期单独覆盖。'),
          h(Row, { label: '限制日' },
            h('div', { style: S.row },
              [['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7]].map(function (d, i) {
                return h('button', {
                  key: d[1], style: i === dpage ? S.tabActive : S.tab,
                  onClick: function () { setDpage(i) },
                }, d[0])
              }))),
          h(Row, { label: '限制时间' },
            h('input', {
              key: 'win-' + active + '-' + dpage,
              style: S.input,
              defaultValue: windowsText((t.dayWindows || {})[dpage + 1] || []),
              placeholder: '09:00-12:00, 14:00-18:00（留空=不限制）',
              onChange: function (e) {
                var next = Object.assign({}, t.dayWindows || {})
                next[dpage + 1] = parseWindows(e.target.value)
                setTarget(active, 'dayWindows', next)
              },
            })),
          h('p', { style: S.hint }, '只作用于当前选中的这一天；留空表示这一天不限制（全天可跑）。'),
          h(Row, { label: '当天间隔（秒）' },
            h('input', {
              key: 'itv-' + active + '-' + dpage,
              style: S.input,
              defaultValue: String((t.dayIntervalSeconds || {})[dpage + 1] || ''),
              placeholder: '留空 = 用上面的默认间隔',
              onChange: function (e) {
                var raw = String(e.target.value).trim()
                var n = Number(raw)
                var next = Object.assign({}, t.dayIntervalSeconds || {})
                if (raw === '' || !isFinite(n) || n <= 0) delete next[dpage + 1]
                else next[dpage + 1] = Math.floor(n)
                setTarget(active, 'dayIntervalSeconds', next)
              },
            })),
          h('p', { style: S.hint }, '只作用于当前选中的这一天；留空表示沿用上面的默认间隔。'),
          h(Row, { label: '仅空闲时' }, h('input', { type: 'checkbox', checked: t.onlyWhenIdle !== false, onChange: function (e) { setTarget(active, 'onlyWhenIdle', e.target.checked) } })),
          h(Row, { label: '每日心跳上限' }, h('input', { style: S.input, value: t.maxWakesPerDay, onChange: function (e) { setTarget(active, 'maxWakesPerDay', Number(e.target.value) || 0) } })),
          h('p', { style: S.hint }, '每个目标每天最多成功向主会话注入多少次行为（内心决定不行动不算）；负数表示不限制。'),
          h(Row, { label: '允许轮次上限' }, h('input', { style: S.input, value: t.maxContinueRounds == null ? 5 : t.maxContinueRounds, onChange: function (e) { setTarget(active, 'maxContinueRounds', Number(e.target.value) || 0) } })),
          h('p', { style: S.hint }, '一次心跳里，主会话最多能请求续做几轮；到上限自动结束；负数表示不限制。'),
          h(Row, { label: '主会话续做请求' }, h('input', { type: 'checkbox', checked: t.allowReport !== false, onChange: function (e) { setTarget(active, 'allowReport', e.target.checked) } })),
          h('p', { style: S.hint }, '开启后主会话可以用 heartbeat_report 跟内心会话说"我还想继续做…"。'),
          h(Row, { label: '内心会话决策参考' }, h('input', { type: 'checkbox', checked: t.allowPeek !== false, onChange: function (e) { setTarget(active, 'allowPeek', e.target.checked) } })),
          h('p', { style: S.hint }, '开启后内心会话可以用 heartbeat_peek 读主会话的原文，再决定是否同意续做。'),
          h(Row, { label: '抑制提示' },
            h('input', { key: 'sup-' + active, style: S.input, defaultValue: t.suppressHint || '考虑成本（token、时间）、有没有新信息，自己决定要不要继续。', onChange: function (e) { setTarget(active, 'suppressHint', e.target.value) } })),
          h('p', { style: S.hint }, '续做提示里 {{hint}} 那一句；模板其它部分在配置文件里改。'),

          h('div', { style: S.divider }),
          h('div', { style: S.row },
            h('h4', { style: Object.assign({}, S.subTitle, { flex: 1, margin: 0 }) }, '行为池（这个目标专用）'),
            h('button', { style: S.tab, onClick: addBehavior }, '＋ 新增行为'),
            h('button', { style: Object.assign({}, S.tab, bActive < targetDefaults().length ? { opacity: 0.45, cursor: 'not-allowed' } : {}), disabled: bActive < targetDefaults().length, onClick: function () { removeBehavior(bActive) } }, '删除这个行为')),
          h('div', { style: S.row },
            behaviors.map(function (bb, i) {
              return h('button', { key: i, style: i === bActive ? S.tabActive : S.tab, onClick: function () { setBpage(i) } }, (bb.id || '行为') + ' · ' + (bb.weight == null ? 1 : bb.weight))
            })),
          h(Row, { label: '行为名' }, h('input', { style: S.input, value: b.id || '', onChange: function (e) { setBehavior(bActive, 'id', e.target.value) } })),
          h(Row, { label: '权重' }, h('input', { style: S.input, value: b.weight == null ? 1 : b.weight, onChange: function (e) { setBehavior(bActive, 'weight', Number(e.target.value) || 0) } })),
          h(Row, { label: '唤醒主会话' },
            h('input', { type: 'checkbox', checked: b.wake !== false, onChange: function (e) { setBehavior(bActive, 'wake', e.target.checked) } })),
          h('p', { style: S.hint }, '取消勾选表示这个行为代表沉默（选它不唤醒主会话）。'),
          h(Row, { label: '提示词' },
            h('input', {
              key: 'bp-' + active + '-' + bActive,
              style: S.input,
              defaultValue: b.prompt || '',
              placeholder: '可选；留空则主会话只按行为名自行理解',
              onChange: function (e) { setBehavior(bActive, 'prompt', e.target.value) },
            })),
          h('p', { style: S.hint }, '每个目标独立的池子。前面 ' + targetDefaults().length + ' 项是默认行为：可改不可删；要增删默认行为请打开配置文件改 defaultBehaviors。'),
        ),

        h('div', { style: S.row },
          h('button', { style: S.btn, disabled: busy, onClick: save }, '保存'),
          h('button', { style: S.btn, disabled: busy, onClick: function () { load(); setMsg('已丢弃修改，重新从宿主读取。') } }, '撤销修改'),
          h('button', { style: S.btn, onClick: openConfig }, '打开配置文件'),
          msg ? h('span', { style: msg.indexOf('失败') >= 0 ? S.err : S.ok }, msg) : null),

        h('div', { style: S.card },
          h('h3', { style: Object.assign({}, S.title, { margin: 0 }) }, '最近心跳 · ' + (t.name || '未命名')),
          visibleEvents.length === 0 ? h('p', { style: S.desc }, '这个目标还没有记录。') :
            h('div', { style: S.events }, visibleEvents.slice().reverse().map(function (e, i) { return h('div', { key: i, style: S.evRow }, humanize(e)) })),
          h('p', { style: S.hint }, '只记录程序层：有没有把唤醒送到心理会话、以及没送到的原因。往下滚可以翻更早的记录；想看它想了什么，直接点进心理会话。'),
        ))
    }

    // ── settings nav icon（复用 dsh-restart-now 的 DOM 增强思路）──
    var HEART_SVG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.2' stroke-linejoin='round' stroke-linecap='round'>" +
      "<path d='M8 14C6 12.2 1.5 9.2 1.5 6C1.5 3.8 3.2 2.4 5.2 2.4C6.6 2.4 7.5 3.2 8 4.2C8.5 3.2 9.4 2.4 10.8 2.4C12.8 2.4 14.5 3.8 14.5 6C14.5 9.2 10 12.2 8 14Z'/>" +
      "<path d='M4.6 7.9h1.5l.7-1.4 1.1 2.9 1-2h1.5' stroke-width='1'/>" +
      "</svg>")

    function installNavIcon() {
      try {
        if (typeof document === 'undefined') return
        if (document.getElementById('hbr-nav-style') === null) {
          var style = document.createElement('style')
          style.id = 'hbr-nav-style'
          style.textContent = [
            '[data-hbr-nav]{display:inline-flex;align-items:center;gap:6px}',
            '[data-hbr-nav] > svg,[data-hbr-nav] > img,[data-hbr-nav] > i,',
            '[data-hbr-nav] > span[class*="icon"],[data-hbr-nav] > span[class*="Icon"]{display:none}',
            '[data-hbr-nav]::before{content:"";width:16px;height:16px;flex:none;background:currentColor;',
            '-webkit-mask:url("' + HEART_SVG + '") center/16px 16px no-repeat;',
            'mask:url("' + HEART_SVG + '") center/16px 16px no-repeat}',
          ].join('')
          document.head.appendChild(style)
        }
        // 0.2.2 起导航不再是固定的 nav>button：放宽选择器，只按可见文本认领。
        var nodes = document.querySelectorAll('nav button, nav a, nav [role="tab"], nav [role="menuitem"], nav li')
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i]
          var text = (el.textContent || '').replace(/\s+/g, '')
          var isOurs = text === '心跳' || text === '心跳设置'
          if (isOurs) {
            if (!el.hasAttribute('data-hbr-nav')) el.setAttribute('data-hbr-nav', '')
          } else if (el.hasAttribute('data-hbr-nav')) {
            el.removeAttribute('data-hbr-nav')
          }
        }
      } catch (e) { /* 增强失败不影响功能 */ }
    }

    function startNavIcon() {
      installNavIcon()
      if (typeof MutationObserver === 'undefined') return
      var timer = null
      var observer = new MutationObserver(function () {
        if (timer !== null) return
        timer = setTimeout(function () { timer = null; installNavIcon() }, 150)
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    }

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      startNavIcon()
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'heartbeat-random',
          order: 215,
          label: '心跳',
        }, HeartbeatSettings)
      })
    }

    return module.exports
  },
})
