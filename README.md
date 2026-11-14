# dsh-heartbeat-random

给 DeepSeek Harness 的多目标「心跳」插件：定时醒来，先让一个**内心会话**判断这次做什么，再把选中的行为注入**主会话**。

不是定时任务——到点先"想"，可以什么都不做。

## 概念

- **目标**：一个目标 = 主会话 + 内心会话，逐对独立配置（节律、行为池、提示词、模型、超时）。
- **主会话**：真正被唤醒去干活的会话。
- **内心会话**：先做判断的会话；默认 `heartbeat-inner`，不存在则自动创建并挂到目标工作区。

## 调度（黑名单语义）

| 配置 | 含义 |
|---|---|
| **禁用日** | 选中的星期里，才应用"禁用时间" |
| **禁用时间** | `09:00-12:00, 14:00-18:00`，支持跨零点与多段；留空 = 不限制 |

1. 选了禁用日 → 只有这些天里、落在禁用时间的时段不跑；不在禁用日里的天（如周末）全天都跑；
2. 没选禁用日 → 禁用时间对每天生效；
3. 两者都留空 → 全天候跑；
4. 新增目标默认七天全禁 + `00:00-24:00`，需手动放开。

走出禁用段的**那一刻**算允许段起点：若上次判断早于该起点，立即触发一次。

**每日心跳上限**：每个目标每天最多**成功向主会话注入**多少次行为（内心决定不行动不算）。**负数 = 不限制。**

### DeepSeek 谷时配法

| 禁用日 | 禁用时间 |
|---|---|
| 一 二 三 四 五 | `09:00-12:00, 14:00-18:00` |

## 行为池（两组）

每个目标有两组行为，实际参与判断的是**两组合并**后的池子：

| 字段 | 说明 |
|---|---|
| `defaultBehaviors` | **默认行为区**：设置页里和普通行为一起显示、可改名/改权重/改提示词/改是否唤醒，但**不能删除**（删除会提示「默认行为无法删除」）。增删只能改配置文件，清空也能正常运行。 |
| `behaviors` | 普通行为池：设置页可增删改。 |

每个行为项：

```jsonc
{ "id": "聊天", "weight": 1, "wake": true, "prompt": "主动找主人说句话。" }
```

- `wake: false` = 这个行为代表**沉默**，选它不会注入主会话；
- `wake: true`（默认）= 选中即唤醒主会话；
- `prompt` 可选，缺省时主会话按行为名的含义自行理解；
- 权重是软信号：插件不做加权随机，由内心自己权衡。

## 决策与续做

**唤醒决策**（内心会话，`heartbeat_decide`）：

```json
{ "behavior": "聊天", "reason": "一句话理由" }
```

只填行为名，不再有 `wake` 字段——是否唤醒由行为本身的 `wake` 决定。行为名无效时工具会返回可用列表，**不消耗本次判断机会**，可以重试。

**续做**（主会话调 `heartbeat_report` 表达"还想继续做"）：

```
main heartbeat_report("做完了 X，还想继续 Y")
  → 内心收到 continuePrompt（模板来自配置，含 {{hint}}）
  → 内心调 heartbeat_continue({ allow, instruction })
  → 允许：主会话收到 "[心跳·续做 第 N 轮] <instruction>"
```

- **允许轮次上限**：默认 5，**负数 = 不限制**（提示里 `{{cap}}` 显示"不限"）；
- **主会话续做请求**：关掉后主会话不能调 `heartbeat_report`；
- **内心会话决策参考**：关掉后内心不能调 `heartbeat_peek`；
- **抑制提示**（设置页可改，字段 `suppressHint`）：续做提示里 `{{hint}}` 那一句。

## 提示词与模型（配置文件编辑）

每个目标各自带：

| 字段 | 占位符 | 用途 |
|---|---|---|
| `wakePrompt` | `{{time}}` `{{behaviors}}` | 普通心跳唤醒提示 |
| `continuePrompt` | `{{text}}` `{{round}}` `{{cap}}` `{{elapsed}}` `{{status}}` `{{hint}}` | 续做判断提示 |
| `innerProvider` / `innerModel` | — | 新建/恢复内心会话用的模型 |
| `mainProvider` / `mainModel` | — | 恢复主会话用的模型（缺了会 `{{model}}` 无值报 UNKNOWN） |
| `decideTimeoutMs` | — | 等内心给判断的超时（秒，设置页可改） |

占位符可选：不写就原样输出；但 `continuePrompt` 不写 `{{text}}` 的话，内心看不到主会话的报告内容。

## 配置示例

`$DSH_HOME/storages/heartbeat-random/config.json`，每轮重读：

```jsonc
{
  "enabled": true,
  "tickSeconds": 60,
  "hideArchivedSessions": true,
  "targets": [
    {
      "name": "对话",
      "targetCwd": "E:\\dsh-workspace\\your-workspace",
      "targetSessionId": "session-...",
      "innerSessionId": "heartbeat-inner",
      "innerCwd": "E:\\dsh-workspace\\your-workspace",
      "enabled": true,
      "intervalSeconds": 600,
      "days": [1, 2, 3, 4, 5],
      "windows": [{ "from": "9:00", "to": "12:00" }, { "from": "14:00", "to": "18:00" }],
      "onlyWhenIdle": true,
      "maxWakesPerDay": 25,
      "maxContinueRounds": 5,
      "allowReport": true,
      "allowPeek": true,
      "decideTimeoutMs": 180000,
      "innerProvider": "deepseek-account",
      "innerModel": "deepseek-flash",
      "mainProvider": "deepseek-account",
      "mainModel": "deepseek-flash",
      "suppressHint": "考虑成本（token、时间）、有没有新信息，自己决定要不要继续。",
      "defaultBehaviors": [
        { "id": "跳过", "weight": 3, "wake": false }
      ],
      "behaviors": [
        { "id": "聊天", "weight": 1, "wake": true, "prompt": "主动找对方说句话。" },
        { "id": "上网", "weight": 3, "wake": true, "prompt": "用 browser_* 随手打开一个网页看看。" }
      ],
      "wakePrompt": "...",
      "continuePrompt": "..."
    }
  ],
  "scheduleMode": "blacklist"
}
```

## 设置页

**设置 → 心跳**（导航图标为心形 + 脉搏，DOM 增强）：

- 每个目标一页：名字、工作区、主会话、内心会话（在线徽标）、启用、间隔、禁用日七按钮、禁用时间（单行）、仅空闲、每日心跳上限、允许轮次上限、两个开关、抑制提示、心跳超时（秒）；
- 行为池：与默认行为**同一个切页列表**，默认项删除按钮置灰并提示无法删除；新增只进普通池；
- 按钮：保存 / 撤销修改 / 打开配置文件（系统默认程序直开）；
- 最近心跳：只显示当前目标的事件，可滚动。

## 工具

| 工具 | 作用 |
|---|---|
| `heartbeat_tick` | 手动触发一次评估（忽略时间窗与间隔） |
| `heartbeat_decide` | 内心专用：只报行为名，无效名可重试 |
| `heartbeat_continue` | 内心专用：回答续做是否允许 + 指示 |
| `heartbeat_report` | 主会话用：告诉内心"还想继续做什么" |
| `heartbeat_peek` | 内心用：读主会话最近 N 条原文 |
| `heartbeat_behaviors` | 主会话用：对普通行为池增删改（list/add/update/remove） |

## 数据文件

| 路径 | 内容 |
|---|---|
| `storages/heartbeat-random/config.json` | 配置（含提示词、行为池） |
| `storages/heartbeat-random/events.jsonl` | 程序层事件（唤醒/跳过/未知行为等） |
| `storages/heartbeat-random/state.json` | 当日注入次数、上次判断时间 |
| `storages/heartbeat-random/apply.log` | apply 阶段错误追踪 |

## 已知限制

- `workspaces` 不是可注入服务，新建内心会话的分组要重启后才在界面刷新；
- 设置图标靠 nav 文本匹配，改了 label 会退回齿轮；
- 法定节假日无法自动识别；
- 权重只是提示，不是硬性概率；
- 配置文件 JSON 写坏时插件会静默回退默认值；
- 设置页保存是整份覆盖：改完配置后先刷新页面，别用旧页面点保存。

## 依赖

零运行时依赖（Node 内置模块）。peer 只用到 `agents`、`tools`、`webServer` 服务。
