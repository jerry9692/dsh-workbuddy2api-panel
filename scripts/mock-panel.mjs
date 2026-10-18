#!/usr/bin/env node
/**
 * 一个假的面板，用来离线验证 dsh-workbuddy2api-panel。
 *
 * 不依赖任何第三方包，只用 node:http。接口形状照着
 * workbuddy2api-panel 的 internal/panel 手写，够插件跑通
 * 「连接 → 拉模型 → 写配置 → 展示额度/用量」。
 *
 *   node scripts/mock-panel.mjs --port 7863
 *   node scripts/mock-panel.mjs --port 7863 --models 40 --fail-auth
 *   node scripts/mock-panel.mjs --port 7863 --empty
 *
 * 运行中可以用下面这些接口改状态（方便手工验证下架、余额归零这些场景）：
 *   POST /mock/models/remove  {"id":"cn:kimi-k3-1"}
 *   POST /mock/models/add     {"id":"cn:new-model","name":"New"}
 *   POST /mock/credits        {"realm":"global","credits":0}
 *   POST /mock/package-expiry {"days":2}     让第一个积分包 2 天后到期
 *   POST /mock/reset
 *   GET  /mock/state
 */

import { createServer } from 'node:http'

/** 解析 `--key value` 和 `--flag`。 */
function parseArgs(argv) {
  const args = { port: 7863, models: 0, credits: '', realm: '', failAuth: false, empty: false, authRequired: true }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    const take = () => {
      index += 1
      return next
    }
    if (key === 'port') args.port = Number(take()) || 7863
    else if (key === 'models') args.models = Number(take()) || 0
    else if (key === 'credits') args.credits = take() ?? ''
    else if (key === 'realm') args.realm = take() ?? ''
    else if (key === 'fail-auth') args.failAuth = true
    else if (key === 'empty') args.empty = true
    else if (key === 'no-auth') args.authRequired = false
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

/** 基础模型库：id / 名称 / 倍率 / 档位 / 能力，和真面板的字段一一对应。 */
const CATALOG = [
  { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', credits: 'x0.11', efforts: ['low', 'high', 'max'], def: 'high', images: true, ctx: 1000000, out: 64000, vendor: 'deepseek' },
  { id: 'cn:deepseek-v4-pro', name: 'Deepseek-V4-Pro', credits: 'x0.51', efforts: ['low', 'medium', 'high', 'max'], def: 'high', images: true, ctx: 1000000, out: 128000, vendor: 'deepseek' },
  { id: 'cn:glm-5.3', name: 'GLM-5.3', credits: 'x0.79', efforts: ['low', 'high'], def: 'high', images: false, ctx: 200000, out: 32000, vendor: 'zhipu' },
  { id: 'cn:glm-5.3-flash', name: 'GLM-5.3-Flash', credits: 'x0.05', efforts: ['low', 'high'], def: 'low', images: false, ctx: 200000, out: 32000, vendor: 'zhipu' },
  { id: 'cn:kimi-k3-1', name: 'Kimi-K3-1', credits: 'x0.2', efforts: ['high'], def: 'high', images: true, ctx: 256000, out: 32000, vendor: 'moonshot' },
  { id: 'cn:step-5-preview', name: 'Step-5-Preview', credits: 'x0.29', efforts: ['low', 'high'], def: 'high', images: false, ctx: 128000, out: 16000, vendor: 'stepfun' },
  { id: 'cn:hy3', name: 'Hy3', credits: 'x0', efforts: ['high'], def: 'high', images: false, ctx: 128000, out: 16000, vendor: 'tencent' },
  { id: 'global:deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0', efforts: ['high'], def: 'high', images: true, ctx: 1000000, out: 64000, vendor: 'deepseek' },
  { id: 'global:gpt-6-astra', name: 'GPT-6 Astra', credits: 'x1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], def: 'high', images: true, ctx: 1000000, out: 128000, vendor: 'openai' },
  { id: 'global:gpt-6.1-sol', name: 'GPT-6.1 Sol', credits: 'x1.5', efforts: ['high', 'max'], def: 'high', images: true, ctx: 2000000, out: 200000, vendor: 'openai' },
  { id: 'global:grok-4.7', name: 'Grok-4.7', credits: 'x0.6', efforts: ['high'], def: 'high', images: true, ctx: 256000, out: 32000, vendor: 'xai' },
  { id: 'global:gemini-3.8-flash', name: 'Gemini-3.8-Flash', credits: 'x0.15', efforts: ['low', 'high'], def: 'low', images: true, ctx: 1000000, out: 64000, vendor: 'google' },
]

/** 可变状态：所有 /mock/* 接口改的都是它。 */
const state = {
  models: [],
  accounts: [
    { uid: 'acct-cn-1', nickname: '国内主力', realm: 'cn', credits: 1234, credits_total: 2000, expiring: 400 },
    { uid: 'acct-cn-2', nickname: '国内备用', realm: 'cn', credits: 88, credits_total: 500, expiring: 0 },
    { uid: 'acct-gl-1', nickname: '国际主力', realm: 'global', credits: 300, credits_total: 300, expiring: 300 },
  ],
  packageDays: 30,
  requests: 0,
}

/** 把基础库展开成面板响应。`--models N` 会按需复制出更多模型。 */
function buildModels() {
  const list = args.empty ? [] : structuredClone(CATALOG)
  if (args.credits !== '') for (const model of list) model.credits = args.credits
  if (args.realm !== '') for (const model of list) model.id = model.id.replace(/^(cn|global):/, `${args.realm}:`)
  const want = args.models > 0 ? args.models : list.length
  const base = list.length > 0 ? list : structuredClone(CATALOG)
  while (list.length < want && base.length > 0) {
    const source = base[list.length % base.length]
    const index = list.length
    list.push({ ...structuredClone(source), id: `${source.id}-v${index}`, name: `${source.name} v${index}` })
  }
  return list.map(toPanelEntry)
}

/** 内部模型 → 面板 panelModelEntry。 */
function toPanelEntry(model) {
  return {
    id: model.id,
    name: model.name,
    credits: model.credits,
    default_effort: model.def ?? 'high',
    supported_efforts: model.efforts ?? ['high'],
    can_disable_thinking: model.efforts?.length > 1,
    supports_reasoning: true,
    supports_images: model.images === true,
    supports_tool_call: true,
    context_length: model.ctx ?? 128000,
    max_output_tokens: model.out ?? 16000,
    description: `mock · ${model.vendor ?? 'mock'}`,
    tags: [model.vendor ?? 'mock'],
    vendor: model.vendor ?? 'mock',
    is_default: model.id === 'cn:deepseek-v4.1-flash',
    max_allowed_size: 20,
  }
}

state.models = buildModels()

/** 当前所有模型的请求统计（用量接口用，数字随请求数增长）。 */
function usageSnapshot() {
  const byModel = state.models.slice(0, 6).map((model, index) => ({
    key: model.id,
    realm: model.id.startsWith('global:') ? 'global' : 'cn',
    requests: 12 + index * 7,
    errors: 0,
    prompt_tokens: 8000 + index * 3000,
    completion_tokens: 2000 + index * 800,
    total_tokens: 10000 + index * 3800,
    credits: 1.2 + index * 0.7,
    credits_per_1m_tokens: 0.12,
    cache_hit_tokens: 3000,
    cache_miss_tokens: 7000,
    cache_hit_rate: 0.3,
    avg_latency_ms: 1200 + index * 200,
    avg_tokens_per_second: 45,
  }))
  const totals = byModel.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      errors: 0,
      prompt_tokens: sum.prompt_tokens + row.prompt_tokens,
      completion_tokens: sum.completion_tokens + row.completion_tokens,
      total_tokens: sum.total_tokens + row.total_tokens,
      credits: sum.credits + row.credits,
      cache_hit_tokens: sum.cache_hit_tokens + row.cache_hit_tokens,
      cache_miss_tokens: sum.cache_miss_tokens + row.cache_miss_tokens,
      avg_latency_ms: 1400,
      avg_tokens_per_second: 45,
    }),
    { requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, credits: 0, cache_hit_tokens: 0, cache_miss_tokens: 0, avg_latency_ms: 0, avg_tokens_per_second: 0 },
  )
  const byRealm = ['cn', 'global'].map((realm) => {
    const rows = byModel.filter((row) => row.realm === realm)
    return {
      key: realm,
      realm,
      requests: rows.reduce((sum, row) => sum + row.requests, 0),
      total_tokens: rows.reduce((sum, row) => sum + row.total_tokens, 0),
      credits: rows.reduce((sum, row) => sum + row.credits, 0),
    }
  })
  return {
    totals: { ...totals, cache_hit_rate: totals.cache_hit_tokens / Math.max(1, totals.cache_hit_tokens + totals.cache_miss_tokens) },
    by_realm: byRealm,
    by_account: state.accounts.map((account, index) => ({
      key: account.uid,
      realm: account.realm,
      requests: 10 + index * 5,
      total_tokens: 9000,
      credits: 1.1,
    })),
    by_model: byModel,
    series: [],
    buckets: [],
    file_bytes: 4096,
    since: '2024-01-01T00:00:00Z',
    window_from: new Date(Date.now() - 72 * 3600000).toISOString(),
    window_to: new Date().toISOString(),
    generated: new Date().toISOString(),
  }
}

/** 面板 /panel/api/overview 的响应。 */
function overviewSnapshot() {
  const total = state.accounts.reduce((sum, account) => sum + account.credits, 0)
  const totalEver = state.accounts.reduce((sum, account) => sum + account.credits_total, 0)
  return {
    version: 'mock-1.13.0-panel',
    uptime_sec: Math.floor(process.uptime()),
    auth_required: args.authRequired,
    redis_mode: false,
    sticky_sessions: true,
    total: state.accounts.length,
    healthy: state.accounts.length,
    cooling: 0,
    disabled: 0,
    paused: 0,
    in_flight_full: false,
    model_locks: {},
    accounts: state.accounts.map((account) => ({
      uid: account.uid,
      nickname: account.nickname,
      realm: account.realm,
      credits: account.credits,
      credits_total: account.credits_total,
      credits_expiring: account.expiring,
      credits_earliest_expiry: new Date(Date.now() + state.packageDays * 86400000).toISOString(),
      cooling: false,
      cool_kind: '',
      cool_remaining_sec: 0,
      enterprise: false,
      disabled: false,
      disabled_reason: '',
      paused: false,
      success_count: 42,
      err_total: 1,
      last_success: new Date().toISOString(),
      last_err: '',
      checkin_done: true,
      token_usage: 120000,
      model_costs: {},
      consecutive_fails: 0,
      degrade_until: '',
      in_flight: 0,
      breaker_fails: 0,
      breaker_until: '',
      rate_limited_models: [],
    })),
  }
}

/** 面板 /panel/api/packages 的响应。 */
function packagesSnapshot() {
  const end = Date.now() + state.packageDays * 86400000
  return {
    accounts: state.accounts.map((account) => ({
      uid: account.uid,
      nickname: account.nickname,
      realm: account.realm,
      remain: account.credits,
      size: account.credits_total,
      packages: [
        {
          name: '月度包',
          remain: Math.round(account.credits * 0.8),
          used: Math.round(account.credits_total * 0.2),
          size: account.credits_total,
          end_time: end,
          expires_at: end,
          created_at: Date.now() - 10 * 86400000,
        },
      ],
    })),
  }
}

/** 读请求体（限制 1MB，避免误用成上传接口）。 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/** 统一回 JSON。 */
function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '')
  const method = request.method ?? 'GET'

  // ---- 控制接口：不鉴权，改的是内存里的假数据 ----
  if (path.startsWith('/mock/')) {
    const body = method === 'POST' ? await readBody(request) : {}
    if (path === '/mock/state') return send(response, 200, { models: state.models.map((model) => model.id), accounts: state.accounts, packageDays: state.packageDays })
    if (path === '/mock/models/remove') {
      const before = state.models.length
      state.models = state.models.filter((model) => model.id !== body.id)
      return send(response, 200, { ok: true, removed: before - state.models.length })
    }
    if (path === '/mock/models/add') {
      const model = CATALOG.find((item) => item.id === body.id) ?? { id: body.id ?? 'cn:mock-new', name: body.name ?? 'Mock New', credits: 'x0.3', efforts: ['high'], def: 'high' }
      state.models.push(toPanelEntry(model))
      return send(response, 200, { ok: true, total: state.models.length })
    }
    if (path === '/mock/credits') {
      for (const account of state.accounts) if (account.realm === body.realm) account.credits = Number(body.credits) || 0
      return send(response, 200, { ok: true, accounts: state.accounts })
    }
    if (path === '/mock/package-expiry') {
      state.packageDays = Number(body.days) >= 0 ? Number(body.days) : 30
      return send(response, 200, { ok: true, packageDays: state.packageDays })
    }
    if (path === '/mock/reset') {
      state.models = buildModels()
      state.packageDays = 30
      return send(response, 200, { ok: true, total: state.models.length })
    }
    return send(response, 404, { ok: false, error: 'unknown mock endpoint' })
  }

  // ---- 面板接口：鉴权 ----
  const authorization = request.headers.authorization ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (args.failAuth) return send(response, 401, { ok: false, error: 'invalid_api_key' })
  if (args.authRequired && token === '') return send(response, 401, { ok: false, error: 'missing_api_key' })

  if (path === '/panel/api/models') return send(response, 200, { ok: true, models: state.models })
  if (path === '/panel/api/overview') return send(response, 200, overviewSnapshot())
  if (path === '/panel/api/packages') return send(response, 200, packagesSnapshot())
  if (path === '/panel/api/usage') {
    state.requests += 1
    return send(response, 200, usageSnapshot())
  }
  // /v1/models 也顺手给一个，方便用别的客户端验证连通性。
  if (path === '/v1/models') {
    return send(response, 200, { object: 'list', data: state.models.map((model) => ({ id: model.id, object: 'model', owned_by: model.vendor ?? 'mock' })) })
  }
  if (path === '/panel' || path === '/panel/') return send(response, 200, { ok: true, hint: 'mock panel：接口在 /panel/api/*' })
  return send(response, 404, { ok: false, error: 'not found' })
})

server.listen(args.port, '0.0.0.0', () => {
  console.log(`mock panel 已启动：http://127.0.0.1:${args.port}`)
  console.log(`  模型 ${state.models.length} 个 · 鉴权${args.authRequired ? '开启' : '关闭'}${args.failAuth ? '（强制 401）' : ''}`)
  console.log(`  插件里填 127.0.0.1:${args.port}，API Key 填任意非空值`)
  console.log('  控制接口：GET /mock/state，POST /mock/models/remove|add、/mock/credits、/mock/package-expiry、/mock/reset')
})
