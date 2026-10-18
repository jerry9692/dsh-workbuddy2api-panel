/**
 * dsh-workbuddy2api-panel —— 宿主侧插件。
 *
 * 职责三件事：
 *   1. 连接 workbuddy2api-panel（嗅探/测试/保存地址与 API Key）；
 *   2. 把面板 `/panel/api/models` 的模型写进 llm-pi-ai 路由配置，让 DSH 的模型
 *      选择器直接出现带倍率、分国内/国际的模型，并在面板变动后自动重写；
 *   3. 对外暴露一组 HTTP 接口，供设置页里的插件卡片展示额度与用量。
 *
 * 设计约束（都是踩过的坑）：
 *   - 不 import 任何 @deepseek-ai/* 运行时包。宿主加载失败会直接 exit 1，
 *     而这些包在不同版本间的导出名会变，所以只依赖 cordis 注入的服务对象。
 *   - 不做构建。宿主只要求 `main` 能被 import，所以这里就是纯 ESM。
 *   - API Key 走 credentials 服务（与 llm-pi-ai 的 `apiKeyEnv` 同一个引用名），
 *     不落盘明文。
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULT_PANEL_PORT,
  buildRouteModels,
  computeAlerts,
  normalizeBaseUrl,
  parseAddressLines,
  pollIntervalMs,
  probeCandidates,
  realmOf,
  reconcileModels,
  routeConfigMatches,
  summarizeOverview,
  summarizePackages,
  summarizeUsage,
  toModelRow,
} from './panel.js'

/** cordis 插件名，需与 cordis.patch.yml 里的 `name` 一致。 */
export const name = 'workbuddy-panel'

/**
 * 插件版本，随快照返回，方便在设置页确认加载的是哪一份代码。
 *
 * 直接从 package.json 读：以前这里写死过 `'0.1.0'`，之后包版本一路升到 0.4.0，
 * 设置页却一直显示 0.1.0，排查时被误导过一次。
 */
const PLUGIN_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 面板 API Key 在 credentials 里的引用名，也是 llm-pi-ai 路由的 apiKeyEnv。 */
const DEFAULT_API_KEY_ENV = 'WORKBUDDY2API_API_KEY'

/** llm-pi-ai 插件的 entry id（profile 里的插件实例标识）。 */
const DEFAULT_PROVIDER_ENTRY = 'llm-pi-ai'

/** 写进 llm-pi-ai 的路由键名。 */
const DEFAULT_ROUTE_KEY = 'workbuddy2api'

/** 状态文件默认值。 */
const DEFAULT_STATE = {
  panelUrl: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  providerEntry: DEFAULT_PROVIDER_ENTRY,
  routeKey: DEFAULT_ROUTE_KEY,
  /** 是否把面板模型同步写进 DSH（用户可关）。 */
  sync: true,
  /** 后台轮询间隔，秒。 */
  intervalSeconds: 120,
  /** 用户对每个模型的选择：{ [modelId]: { enabled, efforts } }。 */
  selection: {},
  lastSyncAt: 0,
  lastSyncCount: 0,
  lastSyncError: '',
  panelVersion: '',
  /** 上一轮同步的模型 id 清单，用来判断新增/下架。 */
  lastModelIds: [],
  /** 面板已下架、但还在宽限期内的模型：`{ [id]: { at, model } }`。 */
  retired: {},
  /** 下架宽限期（小时）。 */
  retireHours: 24,
  /** 地址列表（按顺序尝试）：`[{ url, timeoutMs }]`。 */
  panelUrls: [],
  /** 最近一次连通的地址（真正的 base）。 */
  activeUrl: '',
  /** 面板新上架模型的默认处理：`select` 自动勾选 / `ignore` 不勾选 / `notify` 只提示。 */
  newModelPolicy: 'select',
  /** 某个域额度为 0 时，是否在显示名后标注「额度不足」。 */
  lowCreditMark: true,
  /** 告警阈值。 */
  thresholds: { lowCredits: 50, expiryDays: 3, unreachablePolls: 5 },
  /** 告警去重：`{ [key]: 上次提示时间戳 }`。 */
  dismissed: {},
  /**
   * 侧边栏徽标显示什么：
   * `ratio` 剩余/总额、`realms` 国内与国际分开、`remaining` 只显示剩余、`hidden` 不显示。
   */
  footerMode: 'ratio',
  /** 徽标上是否显示状态点。 */
  footerDot: true,
}

/** 侧边栏徽标可选的显示方式。 */
export const FOOTER_MODES = ['ratio', 'realms', 'remaining', 'hidden']

/** 单次面板请求的超时。局域网内 8 秒足够，超时即视为不可达。 */
const REQUEST_TIMEOUT_MS = 8000

/**
 * 定位状态文件所在目录。
 *
 * 优先放在 profile 目录下（和 cordis.patch.yml 同级），这样多 profile 之间互不干扰；
 * settings 服务不可用时退回 `~/.dsh/profiles/desktop`。
 * @param ctx - 宿主上下文。
 * @returns 状态目录的绝对路径。
 */
function stateDirOf(ctx) {
  try {
    const documentPath = ctx.get('settings')?.documentPath
    if (typeof documentPath === 'string' && documentPath !== '') return dirname(documentPath)
  } catch {
    // settings 还没就绪，走下面的兜底路径。
  }
  const profile = process.env.DSH_PROFILE
  if (typeof profile === 'string' && profile !== '') return join(homedir(), '.dsh', 'profiles', profile)
  return join(homedir(), '.dsh', 'profiles', 'desktop')
}

/** 把任意异常压成一行可展示的错误文本。 */
/** 等一会儿（毫秒）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function errorText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 读状态文件；文件缺失或损坏都退回默认值（插件不能因为一个坏文件就起不来）。
 * @param ctx - 宿主上下文。
 * @returns 状态对象。
 */
async function loadState(ctx) {
  const file = join(stateDirOf(ctx), 'workbuddy-panel.json')
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_STATE }
    return { ...DEFAULT_STATE, ...parsed, selection: parsed.selection ?? {} }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/**
 * 原子写状态文件：先写临时文件再 rename，避免轮询写入时被读到半个文件。
 * @param ctx - 宿主上下文。
 * @param state - 要保存的状态。
 */
async function saveState(ctx, state) {
  const dir = stateDirOf(ctx)
  const file = join(dir, 'workbuddy-panel.json')
  await mkdir(dir, { recursive: true })
  const text = serializeState(state)
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
  return text
}

/**
 * 状态对象的磁盘格式。
 *
 * 写盘前比较用它：内容没变就不写，省掉「每 2 分钟一次」的无效写入。
 * @param state - 状态对象。
 * @returns 要写进文件（以及用于比较）的字符串。
 */
function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`
}

/**
 * 解析面板 API Key。
 *
 * credentials 服务的 `resolve` 会按「进程环境 → 凭据库 → .env」的顺序取值，
 * 因此用户在设置页里填的 Key 和 `export WORKBUDDY2API_API_KEY=...` 都生效。
 * @param ctx - 宿主上下文。
 * @param state - 当前状态（提供 apiKeyEnv）。
 * @returns Key 明文，或空串。
 */
async function readApiKey(ctx, state, options = {}) {
  const ref = state.apiKeyEnv !== '' ? state.apiKeyEnv : DEFAULT_API_KEY_ENV
  const deadline = Date.now() + Math.max(0, Number(options.waitMs) || 0)
  for (;;) {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(ref)
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (typeof value === 'string' && value !== '') return value
        // 服务可用、但确实没有这个 key：不用再等，直接看环境变量兜底。
        break
      } catch {
        // 凭据库刚启动、还没 hydrate 完时 resolve 会抛：当作「还没准备好」继续等。
      }
    }
    // DSH 刚启动时凭据服务可能还没注册（`ctx.get('credentials')` 是 undefined）。
    // 这时候直接发请求会光着发出去，被面板 401，用户看到「API Key 无效」——
    // 而实际上只是还没读到。给它一点时间，别把时序问题报成配置问题。
    if (Date.now() >= deadline) break
    await sleep(120)
  }
  const fromEnv = process.env[ref]
  return typeof fromEnv === 'string' ? fromEnv : ''
}

/**
 * 调一次面板接口。
 * @param base - 面板根地址（已归一）。
 * @param apiKey - API Key；面板开启鉴权时必需。
 * @param pathname - 面板路径，如 `/panel/api/models`。
 * @param options - `timeoutMs`。
 * @returns `{ status, ok, body, text }`；网络错误时 `status` 为 0。
 */
async function panelGet(base, apiKey, pathname, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { accept: 'application/json' }
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`
  try {
    const response = await fetch(`${base}${pathname}`, { headers, signal: controller.signal })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    return { status: response.status, ok: response.ok, body, text }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { status: 0, ok: false, body: undefined, text: aborted ? `请求超时（${timeoutMs}ms）` : errorText(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 判定一个地址是不是 workbuddy2api-panel。
 *
 * 只认 `/panel/api/models` 的结构：`{ ok: true, models: [...] }`。返回 401 也算
 * 「是面板，只是 Key 不对」，这对嗅探很有用（能告诉用户地址对了、Key 缺了）。
 * @param base - 候选根地址。
 * @param apiKey - API Key。
 * @returns 判定结果 `{ ok, reason, modelCount }`。
 */
/**
 * 从配置请求体里取出地址列表。
 *
 * 三种写法都认：`addresses`（多行文本，设置页用这个）、`panelUrls`（数组，
 * 给脚本用）、`panelUrl`（单个地址，老版本前端还在用）。
 * @param patch - 请求体。
 * @returns `[{ url, timeoutMs }]`；返回 `null` 表示这次请求没动地址。
 */
function parseAddressEntries(patch) {
  if (typeof patch?.addresses === 'string') return parseAddressLines(patch.addresses)
  if (Array.isArray(patch?.panelUrls)) {
    const entries = []
    const seen = new Set()
    for (const item of patch.panelUrls) {
      const url = normalizeBaseUrl(typeof item === 'string' ? item : item?.url)
      if (url === '' || seen.has(url)) continue
      seen.add(url)
      const raw = Number(typeof item === 'string' ? 0 : item?.timeoutMs)
      entries.push({ url, timeoutMs: Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 120000) : 0 })
    }
    return entries
  }
  if (typeof patch?.panelUrl === 'string') {
    const url = normalizeBaseUrl(patch.panelUrl)
    return url === '' ? [] : [{ url, timeoutMs: 0 }]
  }
  return null
}

async function probeBase(base, apiKey, timeoutMs = 3000) {
  const result = await panelGet(base, apiKey, '/panel/api/models', { timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 3000 })
  if (result.status === 401 || result.status === 403) return { ok: false, auth: true, reason: '面板可达，但 API Key 无效或缺失' }
  if (result.status === 0) return { ok: false, reason: result.text }
  if (result.status !== 200) return { ok: false, reason: `HTTP ${result.status}` }
  const models = result.body?.models
  if (result.body?.ok === true && Array.isArray(models)) return { ok: true, reason: '', modelCount: models.length }
  return { ok: false, reason: '返回内容不是面板的模型接口' }
}

/**
 * 把面板模型写进 llm-pi-ai 的 provider 路由。
 *
 * 写的是 profile patch 里的 volatile 字段，llm-pi-ai 监听 `loader/volatile-update`
 * 后自行重注册模型，所以不需要重启 DSH。
 *
 * 关键点：`compat.supportsReasoningEffort` 必须显式置 true。pi-ai 默认按 URL
 * 猜这个能力，局域网 IP（192.168.x.x:7863）会被判成「不支持 reasoning_effort」，
 * 于是思考档位静默失效。面板的 payload.go 是按 reasoning_effort 分档的，
 * 这里不置 true 就等于把档位功能整个关掉。
 * @param ctx - 宿主上下文。
 * @param state - 当前状态。
 * @param models - 面板返回的模型条目数组。
 * @returns `{ count, at }`。
 */
async function mutateWithRetry(settings, entryId, ops, revision) {
  try {
    await settings.mutate(entryId, ops, revision)
    return revision
  } catch (error) {
    const text = errorText(error)
    if (!/revision|conflict|stale|并发/i.test(text)) throw error
    const fresh = settings.describe().find((row) => row.ns === entryId)
    if (fresh === undefined || fresh.revision === revision) throw error
    await settings.mutate(entryId, ops, fresh.revision)
    return fresh.revision
  }
}

async function syncModelsToDsh(ctx, state, models, baseUrl) {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('settings 服务不可用，无法写入模型')
  const entryId = state.providerEntry !== '' ? state.providerEntry : DEFAULT_PROVIDER_ENTRY
  const routeKey = state.routeKey !== '' ? state.routeKey : DEFAULT_ROUTE_KEY
  const descriptor = settings.describe().find((row) => row.ns === entryId)
  if (descriptor === undefined) throw new Error(`找不到插件配置 "${entryId}"（llm-pi-ai 是否已启用？）`)
  const routeModels = buildRouteModels(models, state.selection)
  if (routeModels.length === 0) throw new Error('没有勾选任何模型（在设置页至少勾一个）')
  // 用运行期的「当前地址」而不是 state.panelUrl：多地址时 panelUrl 只是列表里的一条，
  // 真正在用的是 activeUrl，写错会让 DSH 请求打到连不上的地址。
  const base = normalizeBaseUrl(typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : state.panelUrl)
  if (base === '') throw new Error('面板地址无效')
  const target = {
    displayName: 'WorkBuddy 面板',
    api: 'openai-completions',
    baseURL: `${base}/v1`,
    apiKeyEnv: state.apiKeyEnv !== '' ? state.apiKeyEnv : DEFAULT_API_KEY_ENV,
    compat: { supportsReasoningEffort: true, thinkingFormat: 'openai' },
    models: routeModels,
  }
  // 内容没变就别写：写一次会让 llm-pi-ai 重新注册整条路由的全部模型，
  // 每 2 分钟白做一遍既浪费也可能打扰正在跑的会话。
  const current = descriptor.value?.providers?.[routeKey]
  if (routeConfigMatches(current, target)) {
    return { count: routeModels.length, at: state.lastSyncAt > 0 ? state.lastSyncAt : Date.now(), skipped: true }
  }
  const ops = Object.entries(target).map(([key, value]) => ({
    op: 'set',
    path: ['providers', routeKey, key],
    value,
  }))
  await mutateWithRetry(settings, entryId, ops, descriptor.revision)
  return { count: routeModels.length, at: Date.now(), skipped: false }
}

/**
 * 插件运行期状态：内存缓存 + 磁盘状态，全部操作串行化。
 *
 * 轮询、HTTP 请求、写盘三条路径会同时进来，用一条 promise 链保证不并发写
 * 同一份状态文件、也不会两次 mutate 撞上同一个 revision。
 */
/**
 * 从已存在的 llm-pi-ai 路由里读出面板地址，用于首次安装时自动接管。
 *
 * 用户之前手写过 `providers.workbuddy2api.baseURL`，那就是最可信的地址来源，
 * 比任何候选探测都准。
 * @param ctx - 宿主上下文。
 * @param state - 当前状态（提供 providerEntry / routeKey）。
 * @returns `{ baseUrl, apiKeyEnv }`，读不到返回 null。
 */
function readExistingRoute(ctx, state) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.describe !== 'function') return null
  const entryId = state.providerEntry !== '' ? state.providerEntry : DEFAULT_PROVIDER_ENTRY
  const routeKey = state.routeKey !== '' ? state.routeKey : DEFAULT_ROUTE_KEY
  const descriptor = settings.describe().find((row) => row.ns === entryId)
  const route = descriptor?.value?.providers?.[routeKey]
  if (route === null || typeof route !== 'object') return null
  const baseUrl = normalizeBaseUrl(typeof route.baseURL === 'string' ? route.baseURL : '')
  if (baseUrl === '') return null
  return {
    baseUrl,
    apiKeyEnv: typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv : '',
  }
}

class PanelRuntime {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config ?? {}
    this.state = { ...DEFAULT_STATE }
    this.models = []
    this.overview = null
    this.usage = null
    this.modelsFetchedAt = 0
    this.overviewFetchedAt = 0
    this.usageFetchedAt = 0
    this.busy = Promise.resolve()
    /** 进程启动时刻：冷启动窗口内失败要快试，别退避到 4 分钟。 */
    this.bootedAt = Date.now()
    this.lastSyncError = ''
    /** 连续失败次数，用来算退避间隔。 */
    this.consecutiveFailures = 0
    /** 被 HMR 事务挡掉、等下一次 HTTP 请求补做的同步。 */
    this.pendingSync = false
    /** 上次真正写进磁盘的内容，用来跳过「什么都没变」的写盘。 */
    this.lastPersisted = ''
    this.disposed = false
  }

  /**
   * 写盘，内容没变就跳过。
   *
   * 轮询每 2 分钟跑一次，状态绝大多数时候是不变的；每次都写一遍既费盘也会
   * 让外部（备份、同步盘）反复认为文件被改。状态文件是唯一线索，所以只在
   * 内容真的不同的时候写。
   * @returns 是否真的写了。
   */
  async persist() {
    const text = serializeState(this.state)
    if (text === this.lastPersisted) return false
    await saveState(this.ctx, this.state)
    this.lastPersisted = text
    return true
  }

  /** 把操作排进串行队列。 */
  run(task) {
    const next = this.busy.then(task, task)
    this.busy = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** 首次装载：读盘 + 按配置拉一次数据。 */
  async start() {
    this.state = await loadState(this.ctx)
    this.lastPersisted = serializeState(this.state)
    if (typeof this.config.panelUrl === 'string' && this.state.panelUrl === '') {
      this.state.panelUrl = normalizeBaseUrl(this.config.panelUrl)
    }
    // 老用户手写过 cordis.patch.yml 的 workbuddy2api 路由：地址和 apiKeyEnv 都是现成的，
    // 直接接过来，不用再让人抄一遍（插件自己的配置文件优先级更高）。
    if (this.state.panelUrl === '') {
      const existing = readExistingRoute(this.ctx, this.state)
      if (existing !== null) {
        this.state.panelUrl = existing.baseUrl
        const isDefaultKeyEnv = this.state.apiKeyEnv === '' || this.state.apiKeyEnv === DEFAULT_API_KEY_ENV
        if (isDefaultKeyEnv && existing.apiKeyEnv !== '') this.state.apiKeyEnv = existing.apiKeyEnv
        await this.persist()
      }
    }
    if (this.state.panelUrl !== '') await this.refresh({ sync: true }).catch(() => undefined)
  }

  /**
   * 补做一次被推迟的同步。
   *
   * 插件在配置变更事务里被重新加载时，`settings.mutate` 会抛
   * "HMR transactions cannot be nested"，而 AsyncLocalStorage 的上下文会
   * 传染给这次加载里创建的所有定时器——也就是说后台轮询从此写不进配置。
   * HTTP 请求处理函数跑在干净上下文里，所以把补同步挂在 /state 上。
   * @returns 有补做就返回 true。
   */
  async flushPendingSync() {
    if (!this.pendingSync) return false
    if (this.base === '') return false
    await this.run(() => this.refresh({ sync: true }))
    return true
  }

  /** 面板根地址。 */
  get base() {
    if (typeof this.state.activeUrl === 'string' && this.state.activeUrl !== '') return this.state.activeUrl
    return normalizeBaseUrl(this.state.panelUrl)
  }

  /** 当前地址的超时（0 = 用默认值）。 */
  get timeoutMs() {
    const list = Array.isArray(this.state.panelUrls) ? this.state.panelUrls : []
    const active = list.find((entry) => entry?.url === this.base)
    const value = Number(active?.timeoutMs)
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * 拉取面板数据（模型 / 概览 / 用量），必要时同步模型。
   * @param options - `sync`：是否顺带写 DSH 配置；`hours`：用量窗口。
   * @returns 摘要 `{ models, synced, error }`。
   */
  async refresh(options = {}) {
    const base = this.base
    if (base === '') return { ok: false, error: '还没有配置面板地址' }
    // 没有 Key 也先试一次：面板可能没开鉴权（`auth_required: false`）。
    let apiKey = await readApiKey(this.ctx, this.state, { waitMs: 3000 })
    let modelsResult = await panelGet(base, apiKey, '/panel/api/models', { timeoutMs: this.timeoutMs })
    if (modelsResult.status === 401 || modelsResult.status === 403) {
      // 两种瞬时情况都会短暂 401：
      //   1. DSH 刚启动，凭据服务还没注册/没 hydrate 完 → 请求没带 Key；
      //   2. 面板自己刚启动，config 里的 api_key 还没加载完。
      // 只重试一次，把等待留给初始化；仍然 401 才当成真的配置问题。
      await sleep(apiKey === '' ? 600 : 900)
      apiKey = await readApiKey(this.ctx, this.state, { waitMs: 2000 })
      modelsResult = await panelGet(base, apiKey, '/panel/api/models', { timeoutMs: this.timeoutMs })
      if (modelsResult.status === 401 || modelsResult.status === 403) {
        return this.fail(apiKey === '' ? '还没读到面板 API Key（刚启动时常见，会自动重试）' : 'API Key 无效或缺失')
      }
    }
    if (!modelsResult.ok || !Array.isArray(modelsResult.body?.models)) {
      return this.fail(modelsResult.status === 0 ? modelsResult.text : `模型接口异常（HTTP ${modelsResult.status}）`)
    }
    // 概览要先拉：额度标注（「额度不足」后缀）依赖它，且它失败不影响模型同步。
    await this.refreshOverview()
    await this.refreshUsage(options.hours)
    await this.refreshPackages()
    const now = Date.now()
    // 首次导入（之前没有任何模型记录）不算「新上架」。
    const firstSync = !Array.isArray(this.state.lastModelIds) || this.state.lastModelIds.length === 0
    // 和上一轮对齐：下架的模型先进宽限期，别让正在用它的会话立刻报错。
    const reconciled = reconcileModels(
      modelsResult.body.models,
      { lastIds: this.state.lastModelIds, models: this.rawModels, retired: this.state.retired },
      now,
      Math.max(0, Number(this.state.retireHours) || 0) * 3600000,
    )
    this.state.retired = reconciled.retired
    this.state.lastModelIds = modelsResult.body.models.map((model) => model?.id).filter((id) => typeof id === 'string' && id !== '')
    this.rawModels = reconciled.models
    this.newModels = reconciled.added
    this.lastRemoved = reconciled.removed
    // 新模型的默认勾选策略。首次导入不算「新上架」——否则选「不勾选」会一个模型都不剩。
    if (!firstSync && this.state.newModelPolicy === 'ignore') {
      for (const id of reconciled.added) {
        if (this.state.selection?.[id] !== undefined) continue
        this.state.selection = { ...this.state.selection, [id]: { enabled: false } }
      }
    }
    const models = this.decorate(reconciled.models)
    this.models = models
    this.modelsFetchedAt = now
    this.lastSyncError = ''
    this.consecutiveFailures = 0
    let synced = 0
    if (this.state.sync !== false && options.sync !== false) {
      try {
        const result = await syncModelsToDsh(this.ctx, this.state, models, this.base)
        synced = result.count
        this.state.lastSyncAt = result.at
        this.state.lastSyncCount = result.count
        this.state.lastSyncError = ''
        this.pendingSync = false
      } catch (error) {
        const text = errorText(error)
        if (text.includes('HMR transactions cannot be nested')) {
          // 宿主正在应用配置变更，这次写不进去。留给下一次 HTTP 请求补做，
          // 不把这个内部错误当成用户能理解的问题展示。
          this.pendingSync = true
          this.state.lastSyncError = ''
          this.lastSyncError = ''
        } else {
          this.pendingSync = false
          this.state.lastSyncError = text
          this.lastSyncError = text
        }
      }
    }
    // 关掉自动同步也要落盘：lastModelIds / retired / panelVersion 是「新模型策略」
    // 和「下架宽限」的基准，丢了会让重启后所有模型都被当成首次导入。
    await this.persist()
    // 概览与用量是「锦上添花」，失败不影响模型同步，各自独立降级。
    return { ok: true, models: models.length, synced, error: this.lastSyncError }
  }

  /**
   * 记录一次失败：错误同时写进内存状态和磁盘状态。
   *
   * 只写内存字段会让设置页读到空错误（snapshot 读的是 state.lastSyncError），
   * 用户就看不到「Key 不对」这种最需要看到的提示。
   * @param message - 给用户看的错误文本。
   * @returns `{ ok: false, error }`，方便调用处直接 return。
   */
  async fail(message) {
    this.lastSyncError = message
    this.state.lastSyncError = message
    this.consecutiveFailures += 1
    await this.persist()
    return { ok: false, error: message }
  }

  /** 拉账号池概览（剩余积分）。 */
  async refreshOverview() {
    const base = this.base
    if (base === '') return undefined
    const apiKey = await readApiKey(this.ctx, this.state)
    const result = await panelGet(base, apiKey, '/panel/api/overview', { timeoutMs: this.timeoutMs })
    if (!result.ok || result.body === undefined) return undefined
    this.overview = result.body
    this.overviewFetchedAt = Date.now()
    const version = result.body.version
    if (typeof version === 'string' && version !== '') this.state.panelVersion = version
    return this.overview
  }

  /** 拉用量快照。 */
  async refreshUsage(hours) {
    const base = this.base
    if (base === '') return undefined
    const window = Number(hours) > 0 ? Math.min(Math.floor(Number(hours)), 1440) : 72
    const apiKey = await readApiKey(this.ctx, this.state)
    const result = await panelGet(base, apiKey, `/panel/api/usage?hours=${window}`, { timeoutMs: this.timeoutMs })
    if (!result.ok || result.body === undefined) return undefined
    this.usage = result.body
    this.usageFetchedAt = Date.now()
    return this.usage
  }

  /** 拉积分包明细（用来判断有没有包快到期）。 */
  async refreshPackages() {
    const base = this.base
    if (base === '') return undefined
    const apiKey = await readApiKey(this.ctx, this.state)
    const result = await panelGet(base, apiKey, '/panel/api/packages', { timeoutMs: this.timeoutMs })
    if (!result.ok || result.body === undefined) return undefined
    const withinDays = Number(this.state.thresholds?.expiryDays) || 3
    this.packages = summarizePackages(result.body, Date.now(), withinDays)
    this.packagesFetchedAt = Date.now()
    return this.packages
  }

  /** 额度见底的域（剩余积分 ≤ 0）。 */
  lowCreditRealms() {
    const realms = new Set()
    if (this.overview === null) return realms
    for (const realm of summarizeOverview(this.overview).realms) {
      if (realm.accounts === 0) continue
      if ((Number(realm.credits) || 0) <= 0) realms.add(realm.realm)
    }
    return realms
  }

  /**
   * 给模型打上展示用标记（已下架 / 额度不足），显示名里会体现。
   * @param models - 原始模型数组。
   * @returns 新数组，不修改入参。
   */
  decorate(models) {
    const low = this.state.lowCreditMark === false ? new Set() : this.lowCreditRealms()
    return (Array.isArray(models) ? models : []).map((model) => {
      if (model?.retired === true) return model
      if (low.size > 0 && low.has(realmOf(model?.id))) return { ...model, lowCredits: true }
      return model
    })
  }

  /** 当前该提示的告警。 */
  alerts() {
    return computeAlerts({
      now: Date.now(),
      quota: this.overview === null ? null : summarizeOverview(this.overview),
      packages: this.packages,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastSyncError || this.state.lastSyncError,
      thresholds: this.state.thresholds,
      dismissed: this.state.dismissed,
    })
  }

  /**
   * 改策略（新模型默认、额度标注、宽限期、告警阈值）。
   * @param patch - 只处理出现的字段。
   * @returns 新快照。
   */
  async setPolicy(patch) {
    const body = patch ?? {}
    if (body.newModelPolicy === 'select' || body.newModelPolicy === 'ignore' || body.newModelPolicy === 'notify') {
      this.state.newModelPolicy = body.newModelPolicy
    }
    if (typeof body.lowCreditMark === 'boolean') this.state.lowCreditMark = body.lowCreditMark
    if (Number(body.retireHours) >= 0) this.state.retireHours = Math.min(Math.floor(Number(body.retireHours)), 168)
    if (FOOTER_MODES.includes(body.footerMode)) this.state.footerMode = body.footerMode
    if (typeof body.footerDot === 'boolean') this.state.footerDot = body.footerDot
    const thresholds = body.thresholds
    if (thresholds !== null && typeof thresholds === 'object') {
      const next = { ...this.state.thresholds }
      if (Number(thresholds.lowCredits) >= 0) next.lowCredits = Number(thresholds.lowCredits)
      if (Number(thresholds.expiryDays) >= 0) next.expiryDays = Number(thresholds.expiryDays)
      if (Number(thresholds.unreachablePolls) > 0) next.unreachablePolls = Math.floor(Number(thresholds.unreachablePolls))
      this.state.thresholds = next
    }
    this.models = this.decorate(this.rawModels ?? [])
    await this.persist()
    return this.snapshot()
  }

  /** 关掉一条告警，24 小时内不再提示。 */
  async dismissAlert(key) {
    if (typeof key !== 'string' || key === '') return this.snapshot()
    this.state.dismissed = { ...this.state.dismissed, [key]: Date.now() }
    await this.persist()
    return this.snapshot()
  }

  /** 立即移除一个已下架的模型（不等宽限期）。 */
  async retireNow(id) {
    if (typeof id !== 'string' || id === '') return this.snapshot()
    if (this.state.retired?.[id] !== undefined) {
      const next = { ...this.state.retired }
      delete next[id]
      this.state.retired = next
    }
    this.rawModels = (this.rawModels ?? []).filter((model) => model?.id !== id)
    // 同步清掉「上一轮见过」的记录，否则下一轮会把刚移除的模型当成新下架又捡回来。
    this.state.lastModelIds = (this.state.lastModelIds ?? []).filter((item) => item !== id)
    this.models = this.decorate(this.rawModels)
    if (this.state.sync !== false) {
      try {
        const result = await syncModelsToDsh(this.ctx, this.state, this.models)
        this.state.lastSyncAt = result.at
        this.state.lastSyncCount = result.count
        this.state.lastSyncError = ''
      } catch (error) {
        this.state.lastSyncError = errorText(error)
      }
    }
    await this.persist()
    return this.snapshot()
  }

  /**
   * 清除插件写进 llm-pi-ai 的整条路由。
   *
   * 用 unset 而不是写空对象：写空对象会在配置里留下一个空壳路由，
   * llm-pi-ai 仍然会注册它（只是没有模型），卸载后看着更糊涂。
   * @returns 新快照。
   */
  async clearConfig() {
    const settings = this.ctx.get('settings')
    const entryId = this.state.providerEntry !== '' ? this.state.providerEntry : DEFAULT_PROVIDER_ENTRY
    const routeKey = this.state.routeKey !== '' ? this.state.routeKey : DEFAULT_ROUTE_KEY
    if (settings !== undefined) {
      const descriptor = settings.describe().find((row) => row.ns === entryId)
      if (descriptor !== undefined && descriptor.value?.providers?.[routeKey] !== undefined) {
        await mutateWithRetry(settings, entryId, [{ op: 'unset', path: ['providers', routeKey] }], descriptor.revision)
      }
    }
    // 清完就停手，否则下一轮轮询又会把它写回去。
    this.state.sync = false
    // 地址必须清干净：`get base()` 优先读 activeUrl，只清 panelUrl 的话
    // 下一轮轮询照样连着旧面板，用户以为断开了其实没有。
    this.state.panelUrl = ''
    this.state.activeUrl = ''
    this.state.panelUrls = []
    this.state.lastModelIds = []
    this.state.retired = {}
    this.state.panelVersion = ''
    this.state.lastSyncAt = 0
    this.state.lastSyncCount = 0
    this.state.lastSyncError = ''
    this.rawModels = []
    this.models = []
    this.newModels = []
    this.overview = null
    this.usage = null
    this.packages = null
    this.modelsFetchedAt = 0
    this.overviewFetchedAt = 0
    this.usageFetchedAt = 0
    this.lastSyncError = ''
    await this.persist()
    return this.snapshot()
  }

  /**
   * 拼给前端的状态快照。
   * @returns 可 JSON 化的状态对象（不含 API Key 明文）。
   */
  snapshot() {
    const models = this.models.map((model) => toModelRow(model, this.state.selection))
    const counts = { total: models.length, enabled: 0, cn: 0, global: 0 }
    for (const row of models) {
      if (row.enabled) counts.enabled += 1
      if (row.realm === 'cn') counts.cn += 1
      else if (row.realm === 'global') counts.global += 1
    }
    return {
      pluginVersion: PLUGIN_VERSION,
      panelUrl: this.state.panelUrl,
      baseUrl: this.base,
      activeUrl: this.base,
      addresses: (Array.isArray(this.state.panelUrls) ? this.state.panelUrls : []).map((entry) => ({
        url: entry.url,
        timeoutMs: Number(entry.timeoutMs) || 0,
        active: entry.url === this.base,
      })),
      apiKeyEnv: this.state.apiKeyEnv,
      providerEntry: this.state.providerEntry,
      routeKey: this.state.routeKey,
      sync: this.state.sync !== false,
      intervalSeconds: this.state.intervalSeconds,
      selection: this.state.selection,
      counts,
      models,
      panelVersion: this.state.panelVersion,
      lastSyncAt: this.state.lastSyncAt,
      lastSyncCount: this.state.lastSyncCount,
      lastSyncError: this.state.lastSyncError,
      syncPending: this.pendingSync,
      lastError: this.lastSyncError,
      modelsFetchedAt: this.modelsFetchedAt,
      overviewFetchedAt: this.overviewFetchedAt,
      usageFetchedAt: this.usageFetchedAt,
      quota: this.overview === null ? null : summarizeOverview(this.overview),
      usage: this.usage === null ? null : summarizeUsage(this.usage, 12),
      accounts: this.overview === null ? [] : accountRows(this.overview),
      alerts: this.alerts(),
      newModels: Array.isArray(this.newModels) ? this.newModels : [],
      retired: Object.entries(this.state.retired ?? {}).map(([id, entry]) => ({ id, at: Number(entry?.at) || 0 })),
      policy: {
        footerMode: this.state.footerMode,
        footerDot: this.state.footerDot !== false,
        newModelPolicy: this.state.newModelPolicy,
        lowCreditMark: this.state.lowCreditMark !== false,
        retireHours: Number(this.state.retireHours) || 0,
        thresholds: { ...this.state.thresholds },
      },
      packages: this.packages ?? null,
    }
  }

  /**
   * 更新配置（地址 / Key / 同步开关 / 间隔）。
   * @param patch - 前端提交的字段。
   * @returns 快照。
   */
  async configure(patch) {
    let addressFailure = ''
    if (patch !== null && typeof patch === 'object') {
      const entries = parseAddressEntries(patch)
      if (entries !== null) addressFailure = await this.applyAddresses(entries)
      if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
        const credentials = this.ctx.get('credentials')
        const ref = this.state.apiKeyEnv !== '' ? this.state.apiKeyEnv : DEFAULT_API_KEY_ENV
        if (credentials === undefined) throw new Error('credentials 服务不可用，无法保存 API Key')
        await credentials.set(ref, patch.apiKey.trim())
      }
      if (typeof patch.sync === 'boolean') this.state.sync = patch.sync
      if (Number.isFinite(Number(patch.intervalSeconds)) && Number(patch.intervalSeconds) >= 30) {
        this.state.intervalSeconds = Math.min(Math.floor(Number(patch.intervalSeconds)), 3600)
      }
    }
    await this.persist()
    // 地址全部连不上时把状态存下来再报错：用户至少不用重新敲一遍地址。
    if (addressFailure !== '') throw new Error(addressFailure)
    return this.snapshot()
  }

  /**
   * 按顺序试地址，记住第一个通的。
   * @param entries - `[{ url, timeoutMs }]`。
   * @returns 失败描述（空串表示成功）。
   */
  async applyAddresses(entries) {
    this.state.panelUrls = entries
    if (entries.length === 0) {
      this.state.activeUrl = ''
      this.state.panelUrl = ''
      return ''
    }
    const apiKey = await readApiKey(this.ctx, this.state)
    const failures = []
    let chosen = ''
    let reachableButRejected = ''
    for (const entry of entries) {
      const verdict = await probeBase(entry.url, apiKey, entry.timeoutMs)
      if (verdict.ok === true) {
        chosen = entry.url
        break
      }
      // 401/403 说明地址是对的、只是 Key 不对：这种也算「选中」，让后续同步去报错，
      // 否则用户连地址都存不下来。
      if (verdict.auth === true && reachableButRejected === '') reachableButRejected = entry.url
      failures.push(`${entry.url}（${verdict.reason !== '' ? verdict.reason : '连不上'}）`)
    }
    if (chosen === '' && reachableButRejected !== '') chosen = reachableButRejected
    // 全不通时保留第一个当「当前地址」，让用户能在设置页看到自己填的是什么。
    this.state.activeUrl = chosen !== '' ? chosen : entries[0].url
    this.state.panelUrl = this.state.activeUrl
    return chosen === '' ? `地址都连不上：${failures.join('；')}` : ''
  }

  /**
   * 更新单个模型的选择（是否显示 / 开放哪些档位）。
   * @param id - 模型 id。
   * @param choice - `{ enabled?, efforts? }`。
   * @returns 快照。
   */
  async select(id, choice) {
    if (typeof id !== 'string' || id === '') throw new Error('缺少模型 id')
    const current = this.state.selection[id] ?? {}
    const next = { ...current }
    if (typeof choice?.enabled === 'boolean') next.enabled = choice.enabled
    if (Array.isArray(choice?.efforts)) next.efforts = choice.efforts.filter((level) => typeof level === 'string')
    this.state.selection = { ...this.state.selection, [id]: next }
    await this.persist()
    if (this.state.sync !== false && this.models.length > 0) {
      try {
        const result = await syncModelsToDsh(this.ctx, this.state, this.models, this.base)
        this.state.lastSyncAt = Date.now()
        this.state.lastSyncCount = result.count
        this.state.lastSyncError = ''
      } catch (error) {
        this.state.lastSyncError = errorText(error)
      }
      await this.persist()
    }
    return this.snapshot()
  }

  /**
   * 批量设置所有模型是否显示。
   * @param enabled - 是否显示。
   * @returns 快照。
   */
  async bulk(enabled) {
    const selection = { ...this.state.selection }
    for (const model of this.models) {
      const id = typeof model?.id === 'string' ? model.id : ''
      if (id === '') continue
      selection[id] = { ...selection[id], enabled: enabled === true }
    }
    this.state.selection = selection
    await this.persist()
    if (this.state.sync !== false && this.models.length > 0) {
      try {
        const result = await syncModelsToDsh(this.ctx, this.state, this.models, this.base)
        this.state.lastSyncAt = Date.now()
        this.state.lastSyncCount = result.count
        this.state.lastSyncError = ''
      } catch (error) {
        this.state.lastSyncError = errorText(error)
      }
      await this.persist()
    }
    return this.snapshot()
  }

  /**
   * 只启用「面板上新增、还没进 DSH」的模型。
   *
   * 和 `bulk(true)` 的区别：不动用户手动关掉的模型。前端「全部启用」按钮
   * 在「新模型提示条」里，语义就是这一个，不该顺带打开别的。
   * @returns 快照。
   */
  async enableNew() {
    const ids = Array.isArray(this.newModels) ? this.newModels : []
    if (ids.length === 0) return this.snapshot()
    const selection = { ...this.state.selection }
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') continue
      selection[id] = { ...selection[id], enabled: true }
    }
    this.state.selection = selection
    this.newModels = []
    await this.persist()
    if (this.state.sync !== false && this.models.length > 0) {
      try {
        const result = await syncModelsToDsh(this.ctx, this.state, this.models, this.base)
        this.state.lastSyncAt = Date.now()
        this.state.lastSyncCount = result.count
        this.state.lastSyncError = ''
      } catch (error) {
        this.state.lastSyncError = errorText(error)
      }
      await this.persist()
    }
    return this.snapshot()
  }

  /**
   * 嗅探面板地址。
   *
   * 候选来源：当前地址、当前地址的主机名 + 默认端口、127.0.0.1、localhost。
   * 只做串行探测（局域网里并发扫端口容易被当成攻击），命中即返回。
   * @param extra - 额外候选（用户手动输入）。
   * @returns `{ found, url, candidates: [{ url, ok, reason }] }`。
   */
  async probe(extra) {
    const host = (() => {
      try {
        return new URL(this.base).hostname
      } catch {
        return ''
      }
    })()
    const configured = (Array.isArray(this.state.panelUrls) ? this.state.panelUrls : []).map((entry) => entry.url)
    const candidates = probeCandidates([...toList(extra), ...configured, this.state.panelUrl], host)
    const apiKey = await readApiKey(this.ctx, this.state)
    const results = []
    for (const url of candidates) {
      const entry = (this.state.panelUrls ?? []).find((item) => item?.url === url)
      const verdict = await probeBase(url, apiKey, entry?.timeoutMs ?? 3000)
      results.push({ url, ok: verdict.ok === true, auth: verdict.auth === true, reason: verdict.reason ?? '', modelCount: verdict.modelCount ?? 0 })
      if (verdict.ok === true) {
        // 找到就真的切过去：只写 panelUrl 的话 `get base()` 仍然返回旧的 activeUrl，
        // 后续所有请求还会打那个连不上的地址（「用这个」按钮等于没作用）。
        this.state.panelUrl = url
        this.state.activeUrl = url
        const list = Array.isArray(this.state.panelUrls) ? this.state.panelUrls : []
        this.state.panelUrls = list.some((entry) => entry?.url === url) ? list : [...list, { url, timeoutMs: 0 }]
        await this.persist()
        return { found: true, url, candidates: results }
      }
    }
    return { found: false, url: '', candidates: results }
  }

  /** 关闭轮询。 */
  dispose() {
    this.disposed = true
  }
}

/** 把任意输入摊平成字符串数组。 */
function toList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value === 'string') return [value]
  return []
}

/**
 * 概览里的账号行 → 前端表格行。
 * @param overview - 面板概览响应。
 * @returns 账号行数组。
 */
function accountRows(overview) {
  const accounts = Array.isArray(overview?.accounts) ? overview.accounts : []
  return accounts.map((account) => ({
    uid: typeof account?.uid === 'string' ? account.uid : '',
    nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    realm: typeof account?.realm === 'string' ? account.realm : '',
    credits: Number(account?.credits) || 0,
    creditsTotal: Number(account?.credits_total) || 0,
    cooling: account?.cooling === true,
    coolRemainingSec: Number(account?.cool_remaining_sec) || 0,
    disabled: account?.disabled === true || account?.paused === true,
    disabledReason: typeof account?.disabled_reason === 'string' ? account.disabled_reason : '',
    inFlight: Number(account?.in_flight) || 0,
    successCount: Number(account?.success_count) || 0,
    errTotal: Number(account?.err_total) || 0,
    enterprise: account?.enterprise === true,
  }))
}

/**
 * 读请求体并解析 JSON。
 * @param request - node http 请求。
 * @param limit - 字节上限，防止被超大 body 打爆内存。
 * @returns 解析后的对象（空 body 返回 `{}`）。
 */
async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/** 写 JSON 响应。 */
function sendJson(response, status, payload) {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * 请求是否来自本机。
 *
 * 宿主的 `/api/*` 有会话鉴权，但 `webServer.register` 注册的路由不在那层中间件
 * 之后（插件路由天然是公开的）。本插件只提供只读数据 + 两个会发起网络请求的
 * 接口（探测/测试），所以对非本机来源直接关掉写接口，避免把宿主变成 SSRF 跳板。
 * @param request - node http 请求。
 * @returns 是否为本机回环地址。
 */
function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 写请求是否来自「同一个页面」。
 *
 * 只判回环地址是拦不住浏览器里其它网站的：同机页面向 `127.0.0.1` 发
 * `fetch(..., {mode:'no-cors', headers:{'content-type':'text/plain'}})` 属于
 * 简单请求，浏览器不发预检，`remoteAddress` 也是 127.0.0.1 —— 于是任何网页
 * 都能改面板地址，插件下一轮就会把 `Authorization: Bearer <Key>` 发给攻击者。
 *
 * 三道闸一起用：
 *   1. `Sec-Fetch-Site` 只允许 `same-origin` / `none`（现代浏览器都会带）；
 *   2. 有 `Origin` 就必须和 `Host` 一致（同源页面 POST 也会带 Origin）；
 *   3. 写接口只收 `application/json`（跨站发这个类型会触发预检，而我们不返回 CORS 头）。
 * 非浏览器客户端（curl、测试、脚本）三者都可以没有，靠回环地址这一层兜住。
 * @param request - node http 请求。
 * @returns 是否可信。
 */
function isSameOriginWrite(request) {
  const site = String(request.headers['sec-fetch-site'] ?? '')
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = String(request.headers.origin ?? '')
  if (origin === '') return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = String(request.headers.host ?? '')
  return host !== '' && parsed.host === host
}

/**
 * 写请求的 content-type 是否可接受。
 * @param request - node http 请求。
 * @returns 是否可接受。
 */
function hasJsonContentType(request) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase()
  return type === '' || type.startsWith('application/json')
}

/**
 * 插件入口。
 * @param ctx - 宿主上下文。
 * @param config - 插件配置（cordis.patch.yml 里的 config）。
 */
export function apply(ctx, config) {
  ctx.inject(['webServer'], (webCtx) => {
    const runtime = new PanelRuntime(webCtx, config)

    webCtx.effect(() => {
      runtime.start().catch((error) => {
        runtime.lastSyncError = errorText(error)
      })
      return () => runtime.dispose()
    }, 'workbuddy-panel: startup')

    // 后台轮询：面板模型/额度变了，DSH 里的模型列表跟着变。
    // 用递归 setTimeout 而不是 setInterval：间隔在用户改设置后能立刻生效，
    // 而且上一轮还没跑完时不会叠加请求。
    webCtx.effect(() => {
      let timer
      let stopped = false
      const tick = () => {
        if (stopped) return
        // 连续失败时指数退避，别在面板掉线时每 2 分钟硬撞。
        // 冷启动窗口内失败（刚装、刚改地址、重启后凭据还没就绪）要快试，
        // 否则指数退避会让一次瞬时 401 挂满 4 分钟才自愈。
        const coldStart = Date.now() - runtime.bootedAt < 60000
        const backedOff = pollIntervalMs(runtime.state.intervalSeconds, runtime.consecutiveFailures)
        const interval =
          coldStart && runtime.consecutiveFailures > 0 ? Math.min(15000, backedOff) : backedOff
        timer = setTimeout(() => {
          if (stopped) return
          if (runtime.base === '') {
            tick()
            return
          }
          runtime
            .run(() => runtime.refresh({ sync: true }))
            .catch(() => undefined)
            .finally(() => tick())
        }, interval)
        timer.unref?.()
      }
      tick()
      return () => {
        stopped = true
        clearTimeout(timer)
      }
    }, 'workbuddy-panel: polling')

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: '/workbuddy-panel/api',
          // 把 promise 返回出去：宿主不使用它，但测试可以直接 await 一次请求结束。
          handler: (request, response) =>
            handle(webCtx, runtime, request, response).catch((error) => {
              sendJson(response, 500, { ok: false, error: errorText(error) })
            }),
        }),
      'workbuddy-panel: routes',
    )
  })
}

/**
 * 路由分发。所有写操作都排进 runtime 的串行队列，避免并发改配置。
 * @param ctx - 宿主上下文。
 * @param runtime - 运行期实例。
 * @param request - node http 请求。
 * @param response - node http 响应。
 */
async function handle(ctx, runtime, request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = url.pathname.replace(/^\/workbuddy-panel\/api/, '') || '/'
  const method = (request.method ?? 'GET').toUpperCase()

  if (method !== 'GET') {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, error: '只允许本机发起写操作' })
      return
    }
    if (!isSameOriginWrite(request)) {
      sendJson(response, 403, { ok: false, error: '拒绝跨站请求：写接口只接受同源页面调用' })
      return
    }
    if (!hasJsonContentType(request)) {
      sendJson(response, 415, { ok: false, error: '写接口只接受 application/json' })
      return
    }
  }

  if (method === 'GET' && route === '/state') {
    // 前端每 15 秒轮询一次，正好用来补做被 HMR 事务挡掉的同步。
    await runtime.flushPendingSync()
    sendJson(response, 200, { ok: true, ...runtime.snapshot() })
    return
  }

  if (method === 'GET' && route === '/overview') {
    await runtime.run(() => runtime.refreshOverview())
    sendJson(response, 200, {
      ok: runtime.overview !== null,
      fetchedAt: runtime.overviewFetchedAt,
      overview: runtime.overview,
      quota: runtime.overview === null ? null : summarizeOverview(runtime.overview),
      accounts: runtime.overview === null ? [] : accountRows(runtime.overview),
    })
    return
  }

  if (method === 'GET' && route === '/usage') {
    const hours = Number(url.searchParams.get('hours'))
    await runtime.run(() => runtime.refreshUsage(hours))
    sendJson(response, 200, {
      ok: runtime.usage !== null,
      fetchedAt: runtime.usageFetchedAt,
      usage: runtime.usage === null ? null : summarizeUsage(runtime.usage, 12),
    })
    return
  }

  if (method === 'POST' && route === '/config') {
    const body = await readJsonBody(request)
    const snapshot = await runtime.run(async () => {
      await runtime.configure(body)
      // 同步之后再取快照，否则前端拿到的是刷新前的旧状态（看不到本次同步结果）。
      if (body.refresh !== false) await runtime.refresh({ sync: true })
      return runtime.snapshot()
    })
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/selection') {
    const body = await readJsonBody(request)
    const snapshot = await runtime.run(() => runtime.select(body.id, body))
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/bulk') {
    const body = await readJsonBody(request)
    const snapshot = await runtime.run(() => runtime.bulk(body.enabled === true))
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/enable-new') {
    const snapshot = await runtime.run(() => runtime.enableNew())
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/refresh') {
    const body = await readJsonBody(request)
    const result = await runtime.run(() => runtime.refresh({ sync: body.sync !== false }))
    sendJson(response, 200, { ok: result.ok === true, result, ...runtime.snapshot() })
    return
  }

  if (method === 'POST' && route === '/policy') {
    const body = await readJsonBody(request)
    const snapshot = await runtime.run(() => runtime.setPolicy(body))
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/dismiss') {
    const body = await readJsonBody(request)
    const snapshot = await runtime.run(() => runtime.dismissAlert(body.key))
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/retire') {
    const body = await readJsonBody(request)
    const snapshot = await runtime.run(() => runtime.retireNow(body.id))
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/clear') {
    const body = await readJsonBody(request)
    if (body.confirm !== true) {
      sendJson(response, 400, { ok: false, error: '需要 confirm: true' })
      return
    }
    const snapshot = await runtime.run(() => runtime.clearConfig())
    sendJson(response, 200, { ok: true, ...snapshot })
    return
  }

  if (method === 'POST' && route === '/probe') {
    const body = await readJsonBody(request)
    const result = await runtime.run(() => runtime.probe(body.candidates))
    sendJson(response, 200, { ok: true, ...result })
    return
  }

  if (method === 'POST' && route === '/test') {
    const body = await readJsonBody(request)
    const base = normalizeBaseUrl(typeof body.panelUrl === 'string' ? body.panelUrl : runtime.state.panelUrl)
    if (base === '') {
      sendJson(response, 200, { ok: false, reason: '地址无法解析' })
      return
    }
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : await readApiKey(ctx, runtime.state)
    const verdict = await probeBase(base, apiKey)
    sendJson(response, 200, {
      ok: verdict.ok === true,
      auth: verdict.auth === true,
      reason: verdict.reason ?? '',
      modelCount: verdict.modelCount ?? 0,
      url: base,
    })
    return
  }

  sendJson(response, 404, { ok: false, error: `未知接口 ${method} ${route}` })
}

/** 供外部（测试）复用的常量。 */
export const constants = {
  DEFAULT_PANEL_PORT,
  DEFAULT_API_KEY_ENV,
  DEFAULT_PROVIDER_ENTRY,
  DEFAULT_ROUTE_KEY,
  DEFAULT_STATE,
}
