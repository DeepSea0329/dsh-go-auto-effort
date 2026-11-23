// 自动思考：每条消息发出前，按内容挑选模型支持的思考档位（关闭 / 轻 / 标准 / 深入），
// 不需要手动改模型选择器。原生界面里用一个状态条和一张面板显示当前档位与上次判断。
//
// 实现要点：Harness 在每步准备（agent/pre-step）之前就把本步的 modelSelection 定下来了，
// 因此必须在驱动被唤醒之前改选择。用户消息先进入收件箱，agent/inbox/inserted 在唤醒之前
// 同步触发；此时不能直接 append（收件箱自己的事件还在发布），所以选择动作放到下一个微任务。
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'local-auto-effort'

const STATE_PATH = fileURLToPath(new URL('../state.json', import.meta.url))
const DEBUG = process.env.DSH_AUTO_EFFORT_DEBUG === '1'
const PENDING_TTL = 60_000

const state = { enabled: true }

/** provider\0model → { status: 'pending'|'ready'|'failed', levels: string[], defaultEffort?: string } */
const infoCache = new Map()
/** sessionId → { last, recent } */
const agentMemory = new Map()
/** sessionId → 分类结果（模型能力还没探测到时先记下，下一步再应用） */
const pending = new Map()

/** 宿主服务引用；UI 半侧在核心装载前也能安全访问。 */
const api = { agents: undefined, llm: undefined }

// ── 文案 ──────────────────────────────────────────────────────────────────

const EFFORT_LABELS = {
  off: ['关闭', 'Off'],
  minimal: ['极简', 'Minimal'],
  low: ['轻', 'Low'],
  medium: ['中', 'Medium'],
  high: ['标准', 'High'],
  xhigh: ['较高', 'XHigh'],
  max: ['最高', 'Max'],
}

const TIER_LABELS = {
  trivial: ['闲聊', 'Trivial'],
  light: ['轻量', 'Light'],
  normal: ['标准', 'Standard'],
  deep: ['深入', 'Deep'],
  keep: ['延续', 'Continue'],
}

const REASON_LABELS = {
  filler: ['寒暄', 'chitchat'],
  ack: ['确认', 'ack'],
  continue: ['延续上一轮', 'continuing'],
  long: ['长内容', 'long input'],
  code: ['代码/报错', 'code/error'],
  complex: ['分析/排查', 'analysis'],
  build: ['编写/实现', 'building'],
  why: ['解释/对比', 'explanation'],
  design: ['设计/方案', 'design'],
  question: ['多个问题', 'questions'],
  multi: ['多步骤', 'multi-step'],
  short: ['短消息', 'short'],
}

const zhOf = (locale) => !String(locale ?? '').toLowerCase().startsWith('en')

function pickLabel(table, id, zh) {
  const entry = table[id]
  if (entry !== undefined) return zh ? entry[0] : entry[1]
  return id ?? (zh ? '默认' : 'default')
}

// ── 分类 ──────────────────────────────────────────────────────────────────

const RE_GREETING = /^(?:你好|您好|嗨|哈喽|hi|hello|hey|在吗|在不在|早|早安|晚安|拜拜|bye|谢谢|多谢|感谢|谢啦|thank(?:s| you)?|thx|辛苦了|哈哈+|笑死|太棒了|厉害)[\s!！。.,，~～、…]*$/iu
const RE_ACK = /^(?:好的?|好滴|好呀|行|可以|没问题|ok|okay|嗯+|哦+|噢+|收到|明白|了解|知道了|对|是的|没错|继续吧|开始吧|干吧|go ahead)[\s!！。.,，~～、…]*$/iu
const RE_CONTINUE = /^(?:继续|接着|往下|然后呢|go on|continue|keep going|next)[\s!！。.,，~～、…]*$/iu
const RE_BLOCK = /```|(?:^|\n)\s*(?:Traceback \(most recent call last\)|at\s+\S+\s*\(|\w*Error:|panic:)/u
const RE_COMPLEX = /(?:报错|出错|错误|异常|崩溃|闪退|白屏|卡死|卡住|没反应|失效|不生效|不起作用|用不了|打不开|连不上|不工作|失败|超时|死循环|内存泄漏|排查|调试|定位|性能|优化|并发|死锁|内存|架构|重构|算法|原理|源码|底层|编译|类型系统|分布式|微服务|安全漏洞|瓶颈|压测|基准测试|推导|证明|权衡|状态机|事务|幂等|(?:返回|状态码)\s*5\d\d|\b(?:traceback|stack trace|exception|error|crash|debug|profil(?:e|ing)|performance|concurren\w*|deadlock|memory leak|architect\w*|refactor\w*|algorithm|proof|distributed|microservice|compiler|vulnerab\w*|bottleneck|benchmark|race condition|transaction|idempoten\w*|timeout|infinite loop|re-?render|not working|doesn'?t work|failed|failure|stuck)\b)/iu
const RE_BUILD = /(?:写一个|写个|编写|写段|实现|生成|代码|函数|脚本|程序|组件|页面|插件|接口|正则|数据库|单元测试|部署|改造|重构一下|\b(?:write|implement|build|create|code|script|function|component|regex|database|unit test|deploy)\b)/iu
const RE_WHY = /(?:为什么|为何|怎么|怎样|如何|是否|能否|区别|对比|解释|说明|\b(?:why|how|compare|difference|explain|approach)\b)/iu
const RE_DESIGN = /(?:设计|方案|系统|流程|模块|结构|规划|权衡|\b(?:design|system|workflow|module|structure|plan|trade-?off)\b)/iu

const PREFERENCE = {
  light: ['low', 'minimal', 'medium', 'high', 'xhigh', 'max'],
  normal: ['high', 'medium', 'low', 'xhigh', 'max', 'minimal'],
  deep: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'],
}

/** 判断一条用户消息该用哪一档。返回 null 表示不改。 */
function classify(raw) {
  const text = String(raw ?? '').replace(/\r\n/gu, '\n').trim()
  if (text === '') return null
  if (RE_GREETING.test(text)) return { tier: 'trivial', score: -6, reasons: ['filler'] }
  if (RE_ACK.test(text)) return { tier: 'light', score: -2, reasons: ['ack'] }
  if (RE_CONTINUE.test(text)) return { tier: 'keep', score: 0, reasons: ['continue'] }

  const len = text.length
  let score = 0
  const reasons = []
  if (RE_BLOCK.test(text)) { score += 2; reasons.push('code') }
  if (RE_COMPLEX.test(text)) { score += 3; reasons.push('complex') }
  if (RE_BUILD.test(text)) { score += 1; reasons.push('build') }
  if (RE_WHY.test(text)) { score += 1; reasons.push('why') }
  if (RE_DESIGN.test(text)) { score += 1; reasons.push('design') }

  if (len >= 2000) { score += 5; reasons.push('long') }
  else if (len >= 800) { score += 4; reasons.push('long') }
  else if (len >= 200) { score += 2; reasons.push('long') }

  const questions = (text.match(/[?？]/gu) ?? []).length
  if (questions >= 2) { score += 1; reasons.push('question') }
  if (/\n\s*(?:\d+[.、)]|[-*•])\s/u.test(text) || /\n\s*\n/u.test(text)) { score += 1; reasons.push('multi') }

  if (len <= 10 && questions === 0 && !reasons.includes('build') && !reasons.includes('complex')) {
    score -= 1
    reasons.push('short')
  }

  let tier = score >= 4 ? 'deep' : score >= 2 ? 'normal' : 'light'
  if (tier === 'light' && (reasons.includes('complex') || reasons.includes('build') || reasons.includes('code'))) tier = 'normal'
  if (tier !== 'deep' && reasons.includes('complex') && score >= 4) tier = 'deep'
  return { tier, score, reasons }
}

function pickEffort(levels, tier) {
  const usable = levels.filter((id) => id !== 'off')
  if (tier === 'trivial') return levels.includes('off') ? 'off' : usable[0]
  if (usable.length === 0) return undefined
  const preferences = PREFERENCE[tier] ?? PREFERENCE.normal
  return preferences.find((id) => usable.includes(id)) ?? usable[usable.length - 1]
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function debug(...args) {
  if (DEBUG) console.error('[auto-effort]', ...args)
}

function keyOf(selection) {
  return `${selection.provider}\u0000${selection.model}`
}

function currentOf(agent) {
  try {
    return agent?.model?.current?.()
  } catch {
    return undefined
  }
}

function agentOf(sessionId) {
  if (!sessionId) return undefined
  try {
    return api.agents?.get(sessionId)
  } catch {
    return undefined
  }
}

function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') out += `${part.text}\n`
    if (out.length > 12_000) break
  }
  return out.trim()
}

async function readState() {
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, 'utf8'))
    if (typeof raw?.enabled === 'boolean') state.enabled = raw.enabled
  } catch {
    // 没有存档时默认开启。
  }
}

async function saveState() {
  try {
    await writeFile(STATE_PATH, JSON.stringify({ enabled: state.enabled }), 'utf8')
  } catch {
    // 存档失败不影响本次会话内的开关。
  }
}

// ── 模型能力缓存 ──────────────────────────────────────────────────────────

function warmFor(provider, model) {
  if (!api.llm || typeof provider !== 'string' || typeof model !== 'string') return
  const key = `${provider}\u0000${model}`
  if (infoCache.has(key)) return
  infoCache.set(key, { status: 'pending', levels: [] })
  Promise.resolve()
    .then(() => api.llm.resolveModelInfo(provider, model))
    .then((info) => {
      const efforts = info?.reasoning?.efforts
      const levels = Array.isArray(efforts)
        ? efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string')
        : []
      infoCache.set(key, {
        status: 'ready',
        levels,
        ...info?.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort },
      })
      debug('model info', key, levels.join(','))
    })
    .catch((error) => {
      infoCache.set(key, { status: 'failed', levels: [] })
      debug('model info failed', key, String(error?.message ?? error))
    })
}

function warmAgent(agent) {
  const selection = currentOf(agent)
  if (selection) warmFor(selection.provider, selection.model)
}

function remember(agent, decision, effort, applied) {
  const entry = agentMemory.get(agent.id) ?? { recent: [] }
  const record = {
    tier: decision.tier,
    score: decision.score,
    reasons: decision.reasons,
    effort,
    applied,
    at: Date.now(),
  }
  entry.last = record
  entry.recent = [record, ...entry.recent].slice(0, 6)
  agentMemory.set(agent.id, entry)
}

// ── 核心：按消息改思考档位 ────────────────────────────────────────────────

function applyNow(agent, decision, selection, info) {
  const effort = pickEffort(info.levels, decision.tier)
  if (effort === undefined) return
  if (selection.reasoningEffort === effort) {
    remember(agent, decision, effort, true)
    return
  }
  const target = { provider: selection.provider, model: selection.model, reasoningEffort: effort }
  queueMicrotask(() => {
    if (!state.enabled) return
    try {
      const now = currentOf(agent)
      if (!now || now.provider !== target.provider || now.model !== target.model) return
      agent.model.select(target)
      remember(agent, decision, effort, true)
      debug('apply', agent.id, decision.tier, effort)
    } catch (error) {
      debug('apply failed', String(error?.message ?? error))
    }
  })
}

function onUserMessage(agent, message) {
  if (!state.enabled) return
  const text = textOf(message)
  if (text === '') return
  if (/^\/[a-z][a-z0-9_-]*(?:\s|$)/iu.test(text)) return

  const decision = classify(text)
  if (!decision || decision.tier === 'keep') return

  const selection = currentOf(agent)
  if (!selection) return
  const info = infoCache.get(keyOf(selection))

  if (info === undefined || info.status === 'pending') {
    pending.set(agent.id, { ...decision, at: Date.now() })
    warmFor(selection.provider, selection.model)
    return
  }
  if (info.status === 'failed' || info.levels.length === 0) {
    remember(agent, decision, undefined, false)
    return
  }
  applyNow(agent, decision, selection, info)
}

function installCore(ctx) {
  api.agents = ctx.agents
  api.llm = ctx.llm
  const agents = ctx.agents

  ctx.on('agent/created', ({ agent }) => {
    try {
      warmAgent(agent)
    } catch (error) {
      debug('created failed', String(error?.message ?? error))
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    agentMemory.delete(agent.id)
    pending.delete(agent.id)
  })

  ctx.on('llm/models-updated', () => infoCache.clear())
  ctx.on('llm/adapters-updated', () => infoCache.clear())

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      if (message?.source?.kind !== 'user') return
      onUserMessage(agent, message)
    } catch (error) {
      debug('inbox inserted failed', String(error?.message ?? error))
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'model/selection') {
        const selection = event.data
        if (selection?.provider && selection?.model) {
          const key = `${selection.provider}\u0000${selection.model}`
          if (infoCache.get(key)?.status === 'failed') infoCache.delete(key)
        }
        const agent = agentOf(session.id)
        if (agent) warmAgent(agent)
        return
      }
      if (event.type === 'turn/end') {
        pending.delete(session.id)
      }
    } catch (error) {
      debug('session event failed', String(error?.message ?? error))
    }
  })

  // 模型能力还没探测到时的兜底：下一步开始前再改一次（影响后续步骤）。
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      if (DEBUG) debug('pre-step', payload.agent.id, `turn ${payload.turn} step ${payload.step}`, payload.modelSelection?.reasoningEffort)
      const decision = pending.get(payload.agent.id)
      if (decision !== undefined) {
        pending.delete(payload.agent.id)
        if (Date.now() - decision.at <= PENDING_TTL) {
          const selection = currentOf(payload.agent)
          const info = selection ? infoCache.get(keyOf(selection)) : undefined
          if (selection && info?.status === 'ready' && info.levels.length > 0) {
            const effort = pickEffort(info.levels, decision.tier)
            if (effort !== undefined && selection.reasoningEffort !== effort) {
              payload.agent.model.select({ provider: selection.provider, model: selection.model, reasoningEffort: effort })
              remember(payload.agent, decision, effort, true)
            }
          }
        }
      }
    } catch (error) {
      debug('pre-step failed', String(error?.message ?? error))
    }
    return next()
  })

  try {
    for (const agent of agents.list()) warmAgent(agent)
  } catch (error) {
    debug('warm existing failed', String(error?.message ?? error))
  }
}

// ── 原生界面：状态条 + 面板 ───────────────────────────────────────────────

function stripPayload(scope, zh) {
  if (!state.enabled) return { text: zh ? '自动思考 · 已关' : 'Auto effort · off', icon: 'sparkle' }
  const selection = currentOf(agentOf(scope?.sessionId))
  if (!selection) return { text: zh ? '自动思考 · 待命' : 'Auto effort · idle', icon: 'sparkle' }
  const info = infoCache.get(keyOf(selection))
  if (info?.status === 'ready' && info.levels.length === 0) {
    return { text: zh ? '自动思考 · 不支持' : 'Auto effort · n/a', icon: 'sparkle' }
  }
  const effort = selection.reasoningEffort ?? info?.defaultEffort
  return {
    text: zh ? `自动思考 · ${pickLabel(EFFORT_LABELS, effort, zh)}` : `Auto effort · ${pickLabel(EFFORT_LABELS, effort, zh)}`,
    icon: 'sparkle',
  }
}

function panelData(scope, zh) {
  const agent = agentOf(scope?.sessionId)
  const selection = currentOf(agent)
  const info = selection ? infoCache.get(keyOf(selection)) : undefined
  const memory = agent ? agentMemory.get(agent.id) : undefined
  const last = memory?.last
  const current = selection
    ? pickLabel(EFFORT_LABELS, selection.reasoningEffort ?? info?.defaultEffort, zh)
    : '—'
  const reasons = last?.reasons?.length
    ? last.reasons.filter((key) => REASON_LABELS[key]).map((key) => pickLabel(REASON_LABELS, key, zh)).join(' + ')
    : '—'
  const levels = info?.status === 'ready'
    ? (info.levels.length === 0 ? (zh ? '不支持' : 'not supported') : info.levels.map((id) => pickLabel(EFFORT_LABELS, id, zh)).join(' / '))
    : (zh ? '探测中' : 'detecting')

  return {
    current,
    model: selection ? `${selection.provider} / ${selection.model}` : (zh ? '还没有对话' : 'no session yet'),
    enabled: state.enabled ? (zh ? '已开启' : 'On') : (zh ? '已关闭' : 'Off'),
    last: last
      ? `${pickLabel(TIER_LABELS, last.tier, zh)} · ${zh ? `${last.score} 分` : `score ${last.score}`}`
      : (zh ? '还没判断过' : 'not yet'),
    reason: reasons,
    levels,
    hint: zh
      ? '发送消息时按内容自动挑选档位；闲聊会关掉思考，复杂问题才拉高。'
      : 'Picks an effort from each message; chats skip thinking, hard questions go higher.',
    toggleLabel: state.enabled ? (zh ? '关闭自动' : 'Turn off') : (zh ? '开启自动' : 'Turn on'),
  }
}

function panelView(zh) {
  return {
    type: 'stack',
    title: zh ? '自动思考' : 'Auto effort',
    children: [
      {
        type: 'metric',
        label: zh ? '当前档位' : 'Current effort',
        value: { $: 'data.current' },
        caption: { $: 'data.model' },
      },
      {
        type: 'keyValue',
        items: [
          { label: zh ? '自动切换' : 'Auto', value: { $: 'data.enabled' } },
          { label: zh ? '最近判断' : 'Last', value: { $: 'data.last' } },
          { label: zh ? '判断依据' : 'Why', value: { $: 'data.reason' } },
          { label: zh ? '可用档位' : 'Levels', value: { $: 'data.levels' } },
        ],
      },
      { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
      {
        type: 'actions',
        items: [
          { label: { $: 'data.toggleLabel' }, action: 'toggle', style: 'primary' },
          { label: zh ? '刷新' : 'Refresh', action: 'refresh', icon: 'refresh' },
        ],
      },
    ],
  }
}

function installUi(ctx) {
  ctx.dshGo.strip('auto-effort-strip', (scope, emit, caps) => {
    const zh = zhOf(caps?.locale)
    const render = () => {
      try {
        emit(stripPayload(scope, zh))
      } catch (error) {
        debug('strip failed', String(error?.message ?? error))
      }
    }
    render()
    const timer = setInterval(render, 4000)
    return () => clearInterval(timer)
  })

  ctx.dshGo.panel('auto-effort', {
    view: (_scope, caps) => panelView(zhOf(caps?.locale)),
    data: (scope, emit, caps) => {
      const zh = zhOf(caps?.locale)
      const push = () => {
        try {
          emit(panelData(scope, zh))
        } catch (error) {
          debug('panel failed', String(error?.message ?? error))
        }
      }
      push()
      const timer = setInterval(push, 3000)
      return () => clearInterval(timer)
    },
    actions: {
      toggle: (_scope, event) => {
        state.enabled = !state.enabled
        if (!state.enabled) pending.clear()
        saveState()
        const zh = zhOf(event?.locale)
        return {
          toast: state.enabled ? (zh ? '已开启自动思考' : 'Auto effort on') : (zh ? '已关闭自动思考' : 'Auto effort off'),
          refresh: true,
        }
      },
      refresh: () => ({ refresh: true }),
    },
  })
}

// ── 入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx) {
  readState()
  ctx.inject(['agents', 'llm'], (coreCtx) => {
    installCore(coreCtx)
  })
  ctx.inject(['dshGo'], (uiCtx) => {
    installUi(uiCtx)
  })
}

export { classify, pickEffort }
