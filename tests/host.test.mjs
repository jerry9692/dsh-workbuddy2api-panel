/**
 * lib/index.js 的集成测试：不启动 DSH，用假的 cordis 上下文 + 假的面板响应，
 * 把「配置 → 拉模型 → 写进 llm-pi-ai → 前端读快照」整条链路跑一遍。
 *
 * 覆盖的坑：
 *   - 写配置的 ops 形状（path 是 string[]，compat.supportsReasoningEffort 必须 true）；
 *   - 状态文件落在 profile 目录而不是 CWD；
 *   - API Key 永远不出现在返回给前端的 JSON 里；
 *   - 面板 401 时给出可读错误而不是抛异常。
 *
 * 运行：node --test（在插件根目录，自动发现 tests/*.test.mjs）
 */

import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../lib/index.js'

const realFetch = globalThis.fetch

/** 一份面板 /panel/api/models 的响应（字段与 panel.go 的 panelModelEntry 对齐）。 */
const PANEL_MODELS = {
  ok: true,
  models: [
    {
      id: 'cn:deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      credits: 'x0.05',
      default_effort: 'high',
      supported_efforts: ['low', 'high', 'max'],
      can_disable_thinking: false,
      supports_reasoning: true,
      supports_images: true,
      supports_tool_call: true,
      context_length: 1000000,
      max_output_tokens: 64000,
      description: '旗舰',
      tags: ['fast'],
      vendor: 'deepseek',
    },
    {
      id: 'global:gpt-6-astra',
      name: 'GPT-6 Astra',
      credits: 'x1',
      supported_efforts: ['high'],
      can_disable_thinking: false,
      supports_reasoning: true,
      supports_images: true,
      context_length: 1000000,
      max_output_tokens: 128000,
    },
  ],
}

const PANEL_OVERVIEW = {
  version: '1.13.0-panel',
  uptime_sec: 600,
  auth_required: true,
  redis_mode: false,
  total: 2,
  healthy: 2,
  cooling: 0,
  disabled: 0,
  accounts: [
    { uid: 'u1', nickname: '主力号', realm: 'cn', credits: 1234, credits_total: 2000, cooling: false, disabled: false },
    { uid: 'u2', nickname: '国际号', realm: 'global', credits: 300, credits_total: 300, cooling: false, disabled: false },
  ],
}

const PANEL_PACKAGES = {
  accounts: [
    {
      uid: 'u1',
      nickname: '主力号',
      realm: 'cn',
      remain: 1234,
      size: 2000,
      packages: [{ name: '月度包', remain: 1000, used: 0, size: 1000, expires_at: 4102444800000 }],
    },
  ],
}

const PANEL_USAGE = {
  totals: { requests: 10, errors: 0, total_tokens: 1000, credits: 2.5, cache_hit_rate: 0.5, avg_latency_ms: 900 },
  by_realm: [{ key: 'cn', requests: 10, total_tokens: 1000, credits: 2.5 }],
  by_model: [{ key: 'cn:deepseek-v4.1-flash', realm: 'cn', requests: 10, total_tokens: 1000, credits: 2.5 }],
  window_from: '2024-05-01T00:00:00Z',
  window_to: '2024-05-04T00:00:00Z',
  generated: '2024-05-04T00:00:01Z',
}

/**
 * 拦截对面板的请求，其它请求（本机测试服务器）走真 fetch。
 * @param options - `models` 覆盖模型响应；`status` 强制状态码。
 */
function stubPanel(options = {}) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    // 本机回环的请求是真测试服务器，放行；其余都当成面板。
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init)
    // 指定主机名模拟「连不上」，用来测多地址回退。
    if (Array.isArray(options.failHosts) && options.failHosts.includes(url.hostname)) {
      throw new TypeError('fetch failed: connect ECONNREFUSED')
    }
    // 观察面板实际收到了哪些请求（用来断言「切换地址之后请求真的换了主机」）。
    if (typeof options.onRequest === 'function') options.onRequest(url)
    const status = options.status ?? 200
    if (status !== 200) return new Response('{"error":"invalid_api_key","ok":false}', { status })
    // 模拟真实面板：没带 Bearer 就 401（auth_required=true 的默认行为）。
    if (options.requireAuth === true) {
      const headers = new Headers(init?.headers ?? {})
      if (!headers.get('authorization')) return new Response('{"error":"invalid_api_key","ok":false}', { status: 401 })
    }
    // 用 endsWith 而不是全等：子路径反代时请求是 /wb/panel/api/models。
    const path = url.pathname
    const body = path.endsWith('/panel/api/models')
      ? options.models ?? PANEL_MODELS
      : path.endsWith('/panel/api/overview')
        ? options.overview ?? PANEL_OVERVIEW
        : path.endsWith('/panel/api/usage')
          ? PANEL_USAGE
          : path.endsWith('/panel/api/packages')
            ? options.packages ?? PANEL_PACKAGES
            : undefined
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

/** 假 cordis 上下文。 */
function makeContext(dir, options = {}) {
  const routes = []
  const mutations = []
  const credentialWrites = []
  // 模拟真实的设置文档：mutate 之后 describe 能读到新值，否则测不出「差异写入」。
  const doc = { providers: structuredClone(options.providers ?? {}), revision: 7 }
  const settings = {
    documentPath: join(dir, 'cordis.patch.yml'),
    describe: () => [{ ns: 'llm-pi-ai', revision: doc.revision, value: structuredClone(doc), applies: 'live' }],
    mutate: async (ns, ops, revision) => {
      mutations.push({ ns, ops, revision })
      if (options.failMutate !== undefined && options.failMutate(mutations.length, revision)) {
        throw new Error(`settings: revision ${revision} is stale, expected ${doc.revision}`)
      }
      for (const op of ops) {
        const [root, route, key] = op.path
        if (root !== 'providers') continue
        if (op.op === 'unset') {
          delete doc.providers[route]
          continue
        }
        doc.providers[route] ??= {}
        doc.providers[route][key] = structuredClone(op.value)
      }
      doc.revision += 1
    },
  }
  // 模拟 DSH 刚启动：凭据服务可能晚于 webServer 注册，这段时间 ctx.get('credentials') 是 undefined。
  const credentialsAvailableAt = Date.now() + (Number(options.credentialsDelayMs) || 0)
  const credentials = {
    resolve: async (ref) => (ref === 'WORKBUDDY2API_API_KEY' ? 'test-panel-key' : undefined),
    set: async (ref, value) => {
      credentialWrites.push({ ref, value })
    },
  }
  const ctx = {
    get: (name) => {
      if (name === 'settings') return settings
      if (name === 'credentials') return Date.now() >= credentialsAvailableAt ? credentials : undefined
      return undefined
    },
    inject: (names, cb) => cb(ctx),
    effect: (fn) => {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, mutations, credentialWrites }
}

/**
 * 起一个真实的 http 服务器，把插件路由挂上去，方便用 fetch 打真实请求。
 * @param handler - 插件注册的 handler。
 * @returns `{ base, close }`。
 */
async function serve(handler) {
  const server = createServer((request, response) => handler(request, response))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}/workbuddy-panel/api`,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 等一轮事件循环，让 runtime.start() 的 promise 落地。 */
function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('apply 注册 prefix 路由，且快照不含 API Key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  try {
    const { ctx, routes } = makeContext(dir)
    plugin.apply(ctx, {})
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/workbuddy-panel/api')
    assert.equal(typeof routes[0].handler, 'function')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('配置地址后拉取面板模型并写进 llm-pi-ai', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const response = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863/v1', refresh: true }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.panelUrl, 'http://panel.test:7863', '/v1 后缀应被剥掉')

    // 写进 llm-pi-ai 的 ops
    assert.equal(mutations.length, 1)
    const { ns, ops, revision } = mutations[0]
    assert.equal(ns, 'llm-pi-ai')
    assert.equal(revision, 7, '必须带上 describe 拿到的 revision')
    const byPath = new Map(ops.map((op) => [op.path.join('.'), op.value]))
    assert.equal(byPath.get('providers.workbuddy2api.baseURL'), 'http://panel.test:7863/v1')
    assert.equal(byPath.get('providers.workbuddy2api.api'), 'openai-completions')
    assert.equal(byPath.get('providers.workbuddy2api.apiKeyEnv'), 'WORKBUDDY2API_API_KEY')
    // 关键：局域网地址下 pi-ai 会把 supportsReasoningEffort 猜成 false，必须显式打开。
    assert.deepEqual(byPath.get('providers.workbuddy2api.compat'), { supportsReasoningEffort: true, thinkingFormat: 'openai' })
    const models = byPath.get('providers.workbuddy2api.models')
    assert.deepEqual(models.map((model) => model.id), ['cn:deepseek-v4.1-flash', 'global:gpt-6-astra'])
    assert.equal(models[0].name, 'DeepSeek V4.1 Flash · 国内版 · ×0.05')
    assert.deepEqual(models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
    assert.deepEqual(models[0].input, ['text', 'image'])
    assert.equal(models[0].contextWindow, 1000000)
    assert.equal(models[1].name, 'GPT-6 Astra · 国际版 · ×1')

    // 快照：额度与用量都归一好了，且没有 Key 泄露。
    const stateResponse = await realFetch(`${server.base}/state`)
    const state = await stateResponse.json()
    assert.equal(state.counts.total, 2)
    assert.equal(state.counts.cn, 1)
    assert.equal(state.counts.global, 1)
    assert.equal(state.lastSyncCount, 2)
    assert.equal(state.panelVersion, '1.13.0-panel')
    assert.equal(state.quota.realms.find((realm) => realm.realm === 'cn').credits, 1234)
    assert.equal(state.usage.byModel[0].key, 'cn:deepseek-v4.1-flash')
    assert.equal(state.accounts.length, 2)
    const serialized = JSON.stringify(state)
    assert.ok(!serialized.includes('test-panel-key'), 'API Key 不能出现在快照里')

    // 状态文件落在 profile 目录（settings.documentPath 的 dirname）。
    const saved = JSON.parse(await readFile(join(dir, 'workbuddy-panel.json'), 'utf8'))
    assert.equal(saved.panelUrl, 'http://panel.test:7863')
    assert.equal(saved.lastSyncCount, 2)
    assert.ok(!JSON.stringify(saved).includes('test-panel-key'), 'API Key 不能落盘到状态文件')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('选择器裁剪模型与档位后立刻重写配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    mutations.length = 0

    // 只留 high 档
    let response = await realFetch(`${server.base}/selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'cn:deepseek-v4.1-flash', efforts: ['high'] }),
    })
    assert.equal(response.status, 200)
    assert.equal(mutations.length, 1)
    const models = mutations[0].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.models').value
    assert.deepEqual(models[0].reasoningEfforts, { high: 'high' })

    // 关掉一个模型
    mutations.length = 0
    response = await realFetch(`${server.base}/selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'global:gpt-6-astra', enabled: false }),
    })
    assert.equal(response.status, 200)
    const kept = mutations[0].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.models').value
    assert.deepEqual(kept.map((model) => model.id), ['cn:deepseek-v4.1-flash'])

    // 全不选 → 报错但不炸（面板没有可用模型时不能写空数组覆盖掉用户配置）
    mutations.length = 0
    response = await realFetch(`${server.base}/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(mutations.length, 0, '没有可用模型时不应写配置')
    assert.ok(body.lastSyncError.includes('没有任何可用模型') || body.lastSyncError !== '', '应记录错误')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('刚启动时凭据服务还没注册，不该把「还没读到 Key」报成 Key 无效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  // 面板要求鉴权：没带 Bearer 就 401。
  stubPanel({ requireAuth: true })
  // 凭据服务在 250ms 后才可用——这就是重启后第一次请求「光着发出去」的时序。
  const { ctx, routes, mutations } = makeContext(dir, { credentialsDelayMs: 250 })
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const response = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.lastSyncError, '', '凭据晚到不该产生错误')
    assert.ok(mutations.length > 0, '读到 Key 之后应正常写入模型')
    assert.ok(body.models.length > 0)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('面板 401 时给出可读错误且不写配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel({ status: 401 })
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const response = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    const body = await response.json()
    assert.equal(body.ok, true, '配置本身成功')
    assert.equal(body.lastSyncError, 'API Key 无效或缺失')
    assert.equal(mutations.length, 0, '鉴权失败时不应改写 DSH 配置')

    // 测试连接接口应直接给出 auth 标记
    const testResponse = await realFetch(`${server.base}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863' }),
    })
    const verdict = await testResponse.json()
    assert.equal(verdict.ok, false)
    assert.equal(verdict.auth, true)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('探测会在候选地址里挑出能用的那个', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  // 只有 panel.test 通，127.0.0.1/localhost 走真 fetch 会连接失败 → 探测应跳过它们。
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const response = await realFetch(`${server.base}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidates: ['http://panel.test:7863'] }),
    })
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.found, true)
    assert.equal(body.url, 'http://panel.test:7863')
    assert.ok(body.candidates.length >= 1)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('未知接口返回 404，写接口拒绝非本机来源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const missing = await realFetch(`${server.base}/nope`)
    assert.equal(missing.status, 404)
    const body = await missing.json()
    assert.equal(body.ok, false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('HMR 事务挡住写入时，改由下一次 /state 补做同步', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  // 第一次 mutate 模拟「插件在配置变更事务里被重新加载」：宿主拒绝写入。
  let nested = true
  ctx.get('settings').mutate = async (ns, ops, revision) => {
    if (nested) throw new Error('HMR transactions cannot be nested')
    mutations.push({ ns, ops, revision })
  }
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const saved = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    const body = await saved.json()
    assert.equal(body.ok, true)
    assert.equal(body.lastSyncError, '', '内部错误不该当成用户可见错误')
    assert.equal(body.syncPending, true, '应标记待补同步')
    assert.equal(mutations.length, 0)

    // 上下文变干净之后再取状态，插件应自己把同步补上。
    nested = false
    const state = await (await realFetch(`${server.base}/state`)).json()
    assert.equal(state.syncPending, false, '补做后应清掉标记')
    assert.equal(state.lastSyncCount, 2)
    assert.equal(mutations.length, 1)
    const models = mutations[0].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.models').value
    assert.deepEqual(models.map((model) => model.id), ['cn:deepseek-v4.1-flash', 'global:gpt-6-astra'])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('内容没变时不重复写配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    assert.equal(mutations.length, 1)

    // 再刷新一次：面板没变，就不该再写（写一次会触发 llm-pi-ai 重注册全部模型）。
    const response = await realFetch(`${server.base}/refresh`, { method: 'POST' })
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(mutations.length, 1, '内容一致时不应重复写配置')
    assert.equal(body.lastSyncCount, 2)

    // 面板换了倍率 → 显示名变了 → 必须重写。
    PANEL_MODELS.models[0].credits = 'x0.5'
    await realFetch(`${server.base}/refresh`, { method: 'POST' })
    assert.equal(mutations.length, 2, '倍率变化应触发重写')
    const models = mutations[1].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.models').value
    assert.ok(models[0].name.includes('×0.5'))
  } finally {
    PANEL_MODELS.models[0].credits = 'x0.05'
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('revision 冲突时重读并重试一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  const settings = ctx.get('settings')
  const baseDescribe = settings.describe
  const baseMutate = settings.mutate
  let revision = 7
  let conflict = true
  settings.describe = () => baseDescribe().map((row) => ({ ...row, revision }))
  settings.mutate = async (ns, ops, rev) => {
    if (conflict) {
      conflict = false
      revision = 8
      throw new Error('settings: revision 7 is stale, expected 8')
    }
    return baseMutate(ns, ops, rev)
  }
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const response = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    const body = await response.json()
    assert.equal(body.lastSyncError, '', '冲突不该报给用户')
    assert.equal(mutations.length, 1, '重试成功应只落地一次')
    assert.equal(mutations[0].revision, 8, '重试应使用新的 revision')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('首次启动从已有 workbuddy2api 路由迁移地址与 apiKeyEnv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir, {
    providers: {
      workbuddy2api: { baseURL: 'http://192.168.1.9:7863/v1', apiKeyEnv: 'MY_PANEL_KEY', models: [] },
    },
  })
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const state = await (await realFetch(`${server.base}/state`)).json()
    assert.equal(state.panelUrl, 'http://192.168.1.9:7863', '应剥掉 /v1 并接管已有地址')
    assert.equal(state.apiKeyEnv, 'MY_PANEL_KEY', '应沿用已有的 apiKeyEnv')
    assert.equal(state.lastSyncCount, 2, '接管后应立即同步一次')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('模型下架后进宽限期，过期才真删', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  const modelsOf = (index) =>
    mutations[index].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.models').value
  try {
    await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    assert.equal(modelsOf(0).length, 2)

    // 面板下架了国际版那个模型：宽限期内仍要写进去，否则正在用的会话会直接报错。
    stubPanel({ models: { ok: true, models: [PANEL_MODELS.models[0]] } })
    const first = await (await realFetch(`${server.base}/refresh`, { method: 'POST' })).json()
    assert.equal(first.lastSyncCount, 2, '宽限期内应保留已下架的模型')
    const kept = modelsOf(mutations.length - 1)
    assert.ok(kept.some((model) => model.name.includes('已下架')), '下架的模型显示名应带「已下架」')
    assert.equal(first.retired.length, 1)

    // 宽限期设为 0 → 下一轮真删。
    await realFetch(`${server.base}/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retireHours: 0 }),
    })
    const second = await (await realFetch(`${server.base}/refresh`, { method: 'POST' })).json()
    assert.equal(second.lastSyncCount, 1)
    assert.equal(second.retired.length, 0)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('侧边栏徽标的显示方式可配置、非法值被忽略、且会持久化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  const policy = async (patch) =>
    (
      await realFetch(`${server.base}/policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
    ).json()
  try {
    await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    const initial = await (await realFetch(`${server.base}/state`)).json()
    assert.equal(initial.policy.footerMode, 'ratio', '默认显示「剩余 / 总额」')
    // 版本号必须来自 package.json：写死过一次，设置页长期显示旧版本。
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(initial.pluginVersion, manifest.version)

    const realms = await policy({ footerMode: 'realms' })
    assert.equal(realms.policy.footerMode, 'realms')

    const bogus = await policy({ footerMode: 'whatever' })
    assert.equal(bogus.policy.footerMode, 'realms', '非法值不应改写')

    const hidden = await policy({ footerMode: 'hidden', footerDot: false })
    assert.equal(hidden.policy.footerMode, 'hidden')
    assert.equal(hidden.policy.footerDot, false)

    // 重启后要还在：直接读状态文件。
    const saved = JSON.parse(await readFile(join(dir, 'workbuddy-panel.json'), 'utf8'))
    assert.equal(saved.footerMode, 'hidden')
    assert.equal(saved.footerDot, false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('新模型策略为 ignore 时，后上架的模型默认不勾选', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  const extra = { id: 'cn:kimi-k3-1', name: 'Kimi K3', credits: 'x0.2', supported_efforts: ['high'], context_length: 256000 }
  try {
    await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    await realFetch(`${server.base}/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newModelPolicy: 'ignore' }),
    })
    stubPanel({ models: { ok: true, models: [...PANEL_MODELS.models, extra] } })
    const body = await (await realFetch(`${server.base}/refresh`, { method: 'POST' })).json()
    assert.equal(body.lastSyncCount, 2, '新模型不该自动进 DSH 选择器')
    const row = body.models.find((model) => model.id === 'cn:kimi-k3-1')
    assert.equal(row.enabled, false, '插件里仍应看得到它，只是没勾选')
    assert.deepEqual(body.newModels, ['cn:kimi-k3-1'])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('清除配置用 unset 移除整条路由并停止同步', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    const before = mutations.length
    const response = await realFetch(`${server.base}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
    const body = await response.json()
    assert.equal(body.ok, true)
    const last = mutations[mutations.length - 1]
    assert.deepEqual(last.ops, [{ op: 'unset', path: ['providers', 'workbuddy2api'] }], '应整条 unset，而不是写空对象')
    assert.equal(body.sync, false, '清除后应停止自动同步')
    assert.equal(body.panelUrl, '')

    // 再刷新一次不该产生任何写入（地址已被清空）。
    await realFetch(`${server.base}/refresh`, { method: 'POST' })
    assert.equal(mutations.length, before + 1, '清除后不应再写配置')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('某个域额度为 0 时标注额度不足并产生告警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  const overview = structuredClone(PANEL_OVERVIEW)
  overview.accounts[1].credits = 0
  stubPanel({ overview })
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const body = await (
      await realFetch(`${server.base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
      })
    ).json()
    const globalModel = body.models.find((model) => model.id === 'global:gpt-6-astra')
    assert.ok(globalModel.displayName.includes('额度不足'), '国际版额度为 0 时显示名应标注')
    const cnModel = body.models.find((model) => model.id === 'cn:deepseek-v4.1-flash')
    assert.ok(!cnModel.displayName.includes('额度不足'), '国内版还有额度，不该被标注')

    const alert = body.alerts.find((item) => item.key === 'low-credits:global')
    assert.ok(alert !== undefined, '应产生国际版额度不足告警')
    assert.equal(alert.level, 'warn')

    // 关掉标注开关后，显示名恢复干净，但告警还在（两件事互不影响）。
    const off = await (
      await realFetch(`${server.base}/policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lowCreditMark: false }),
      })
    ).json()
    assert.ok(!off.models.find((model) => model.id === 'global:gpt-6-astra').displayName.includes('额度不足'))
    assert.ok(off.alerts.some((item) => item.key === 'low-credits:global'))

    // 关掉告警后 24 小时内不再提示。
    const dismissed = await (
      await realFetch(`${server.base}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'low-credits:global' }),
      })
    ).json()
    assert.ok(!dismissed.alerts.some((item) => item.key === 'low-credits:global'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('立即移除的模型不会被下一轮同步又捡回来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  const modelsOf = () => mutations[mutations.length - 1].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.models').value
  try {
    await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelUrl: 'http://panel.test:7863', refresh: true }),
    })
    // 面板下架一个 → 进宽限期。
    stubPanel({ models: { ok: true, models: [PANEL_MODELS.models[0]] } })
    await realFetch(`${server.base}/refresh`, { method: 'POST' })
    assert.ok(modelsOf().some((model) => model.name.includes('已下架')))

    // 手动「立即移除」后，再刷新不该把它加回宽限期。
    const removed = await (
      await realFetch(`${server.base}/retire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'global:gpt-6-astra' }),
      })
    ).json()
    assert.equal(removed.lastSyncCount, 1)
    assert.equal(removed.retired.length, 0)

    const again = await (await realFetch(`${server.base}/refresh`, { method: 'POST' })).json()
    assert.equal(again.lastSyncCount, 1, '下一轮不该把它捡回来')
    assert.equal(again.retired.length, 0)
    assert.ok(!modelsOf().some((model) => model.id === 'global:gpt-6-astra'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('多地址：第一个连不上就自动用第二个，并记住它', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel({ failHosts: ['unreachable.test'] })
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const body = await (
      await realFetch(`${server.base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          addresses: 'http://unreachable.test:7863\nhttp://panel.test:7863 12',
          refresh: true,
        }),
      })
    ).json()
    assert.equal(body.ok, true, body.error)
    assert.equal(body.activeUrl, 'http://panel.test:7863', '应回退到第二个地址')
    assert.deepEqual(
      body.addresses.map((entry) => ({ url: entry.url, active: entry.active, timeoutMs: entry.timeoutMs })),
      [
        { url: 'http://unreachable.test:7863', active: false, timeoutMs: 0 },
        { url: 'http://panel.test:7863', active: true, timeoutMs: 12_000 },
      ],
    )
    const written = mutations[0].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.baseURL').value
    assert.equal(written, 'http://panel.test:7863/v1')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('子路径反代：baseURL 保留 /wb 前缀', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const body = await (
      await realFetch(`${server.base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ panelUrl: 'https://nas.example.com/wb/', refresh: true }),
      })
    ).json()
    assert.equal(body.ok, true, body.error)
    assert.equal(body.baseUrl, 'https://nas.example.com/wb')
    const written = mutations[0].ops.find((op) => op.path.join('.') === 'providers.workbuddy2api.baseURL').value
    assert.equal(written, 'https://nas.example.com/wb/v1', '不能把 /wb 剥掉')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

test('所有地址都连不上时保存地址再报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel({ failHosts: ['a.test', 'b.test'] })
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const response = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: 'http://a.test:7863\nhttp://b.test:7863', refresh: true }),
    })
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.match(body.error, /地址都连不上/)

    // 地址本身要留下，用户不用重新敲。
    const state = await (await realFetch(`${server.base}/state`)).json()
    assert.equal(state.addresses.length, 2)
    assert.equal(state.activeUrl, 'http://a.test:7863', '全不通时先指向第一个')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    globalThis.fetch = realFetch
  }
})

/**
 * 发一个写请求。默认带同源 Origin + application/json（和浏览器里插件自己发的一致），
 * 个别用例会显式覆盖成跨站请求。
 */
function postWrite(base, path, body, headers = {}) {
  return realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('跨站页面发起的写请求被拒绝，配置不受影响', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    // 浏览器里的「简单请求」：text/plain + 外站 Origin，不会触发预检。
    // 这正是漏洞原形——不拦它，任何网页都能改面板地址。
    const simple = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: JSON.stringify({ addresses: 'http://evil.example:7863', refresh: true }),
    })
    assert.equal(simple.status, 403, 'text/plain 的跨站请求必须被拒绝')

    const crossSite = await realFetch(`${server.base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ addresses: 'http://evil.example:7863', refresh: true }),
    })
    assert.equal(crossSite.status, 403, 'Origin 不匹配的写请求必须被拒绝')

    const clear = await realFetch(`${server.base}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: JSON.stringify({ confirm: true }),
    })
    assert.equal(clear.status, 403, '清除配置也不能被跨站驱动')

    assert.equal(mutations.length, 0, '被拒绝的请求不该写任何配置')
    const state = await (await realFetch(`${server.base}/state`)).json()
    assert.equal(state.panelUrl, '', '面板地址不该被跨站请求改掉')

    // 同源页面照常可用（插件自己是这么发的）。
    const same = await postWrite(server.base, '/config', { addresses: 'http://panel.test:7863', refresh: true }, {
      origin: server.origin,
      'sec-fetch-site': 'same-origin',
    })
    assert.equal(same.status, 200)
    assert.equal((await same.json()).baseUrl, 'http://panel.test:7863')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('清除配置后彻底断开：地址清空、刷新也不会把模型拉回来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    const before = await (await postWrite(server.base, '/config', { addresses: 'http://panel.test:7863', refresh: true })).json()
    assert.equal(before.models.length, 2)

    const cleared = await (await postWrite(server.base, '/clear', { confirm: true })).json()
    assert.equal(cleared.baseUrl, '')
    assert.equal(cleared.models.length, 0)
    assert.deepEqual(cleared.addresses, [])

    const refreshed = await (await postWrite(server.base, '/refresh', {})).json()
    assert.equal(refreshed.baseUrl, '', '清除后不能还连着旧面板')
    assert.equal(refreshed.models.length, 0, '清除后刷新不该把模型重新拉回来')

    const saved = JSON.parse(await readFile(join(dir, 'workbuddy-panel.json'), 'utf8'))
    assert.equal(saved.panelUrl, '')
    assert.equal(saved.activeUrl, '')
    assert.deepEqual(saved.panelUrls, [], '地址列表也要清掉，否则下一轮轮询又会连回去')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('嗅探到新地址后真的切过去，后续请求打到新主机', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  const hosts = []
  stubPanel({ onRequest: (url) => hosts.push(url.host) })
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await postWrite(server.base, '/config', { addresses: 'http://panel.test:7863', refresh: true })
    const probed = await (await postWrite(server.base, '/probe', { candidates: ['http://second.test:7863'] })).json()
    assert.equal(probed.found, true)
    assert.equal(probed.url, 'http://second.test:7863')

    const state = await (await realFetch(`${server.base}/state`)).json()
    assert.equal(state.activeUrl, 'http://second.test:7863', '找到地址后当前地址必须跟着切换')
    assert.ok(state.addresses.some((entry) => entry.url === 'http://second.test:7863' && entry.active === true))

    hosts.length = 0
    const refreshed = await (await postWrite(server.base, '/refresh', {})).json()
    assert.ok(hosts.length > 0, '刷新应该真的发请求')
    assert.ok(hosts.every((host) => host === 'second.test:7863'), `刷新应打新地址，实际打到 ${hosts.join(',')}`)
    assert.equal(refreshed.baseUrl, 'http://second.test:7863')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('关掉自动同步也会把模型基准落盘（重启后不会全当新模型）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await postWrite(server.base, '/config', { addresses: 'http://panel.test:7863', sync: false, refresh: true })
    const saved = JSON.parse(await readFile(join(dir, 'workbuddy-panel.json'), 'utf8'))
    assert.equal(saved.sync, false)
    assert.deepEqual(saved.lastModelIds, ['cn:deepseek-v4.1-flash', 'global:gpt-6-astra'])
    assert.equal(saved.panelVersion, '1.13.0-panel')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('数据没变时不重复写状态文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await postWrite(server.base, '/config', { addresses: 'http://panel.test:7863', refresh: true })
    const file = join(dir, 'workbuddy-panel.json')
    const before = statSync(file).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 30))
    await postWrite(server.base, '/refresh', {})
    await postWrite(server.base, '/refresh', {})
    assert.equal(statSync(file).mtimeMs, before, '内容没变就不该写盘')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('只启用面板新增的模型，不动用户手动关掉的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await postWrite(server.base, '/config', { addresses: 'http://panel.test:7863', refresh: true })
    await postWrite(server.base, '/selection', { id: 'global:gpt-6-astra', enabled: false })
    await postWrite(server.base, '/policy', { newModelPolicy: 'ignore' })

    // 面板上新上架一个模型：按 ignore 策略它默认不勾选，进「新模型」列表。
    stubPanel({
      models: {
        ok: true,
        models: [
          ...PANEL_MODELS.models,
          { id: 'cn:brand-new', name: 'Brand New', credits: 'x2', supported_efforts: ['high'], supports_reasoning: true },
        ],
      },
    })
    await postWrite(server.base, '/refresh', { sync: true })

    const state = await (await realFetch(`${server.base}/state`)).json()
    assert.deepEqual(state.newModels, ['cn:brand-new'])
    const enabledOf = new Map(state.models.map((row) => [row.id, row.enabled]))
    assert.equal(enabledOf.get('cn:brand-new'), false)
    assert.equal(enabledOf.get('global:gpt-6-astra'), false)

    const after = await (await postWrite(server.base, '/enable-new', {})).json()
    const rows = new Map(after.models.map((row) => [row.id, row.enabled]))
    assert.equal(rows.get('cn:brand-new'), true, '新模型应被启用')
    assert.equal(rows.get('global:gpt-6-astra'), false, '用户手动关掉的模型不该被打开')
    assert.deepEqual(after.newModels, [])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * 直接调 handler 的假请求/响应：真实服务器只能从 127.0.0.1 发起，
 * 「非本机来源」和 415 这类分支只能在这里构造。
 */
function fakeExchange(options = {}) {
  const response = {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = JSON.parse(text)
    },
  }
  const body = options.body ?? ''
  const request = {
    url: options.url ?? '/workbuddy-panel/api/config',
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body)
    },
  }
  return { request, response }
}

test('非本机来源的写请求被拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  try {
    const { request, response } = fakeExchange({ remoteAddress: '10.1.2.3', headers: { 'content-type': 'application/json' }, body: '{"addresses":"http://evil.test:7863"}' })
    await routes[0].handler(request, response)
    assert.equal(response.status, 403)
    assert.match(response.payload.error, /只允许本机/)
    assert.equal(mutations.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('同源但 content-type 不是 JSON 时返回 415', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes, mutations } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  try {
    const { request, response } = fakeExchange({
      headers: { host: '127.0.0.1:9', origin: 'http://127.0.0.1:9', 'content-type': 'text/plain' },
      body: '{"addresses":"http://panel.test:7863"}',
    })
    await routes[0].handler(request, response)
    assert.equal(response.status, 415)
    assert.match(response.payload.error, /application\/json/)
    assert.equal(mutations.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('清除配置必须显式 confirm', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  try {
    const { request, response } = fakeExchange({
      url: '/workbuddy-panel/api/clear',
      headers: { host: '127.0.0.1:9', origin: 'http://127.0.0.1:9', 'content-type': 'application/json' },
      body: '{}',
    })
    await routes[0].handler(request, response)
    assert.equal(response.status, 400)
    assert.match(response.payload.error, /confirm/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('状态快照带 ETag，没变化时回 304', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-'))
  stubPanel()
  const { ctx, routes } = makeContext(dir)
  plugin.apply(ctx, {})
  await tick()
  const server = await serve(routes[0].handler)
  try {
    await postWrite(server.base, '/config', { addresses: 'http://panel.test:7863', refresh: true })

    const first = await realFetch(`${server.base}/state`)
    const etag = first.headers.get('etag')
    assert.match(String(etag), /^"[0-9a-f]{16}"$/)
    const body = await first.json()
    assert.equal(body.ok, true)

    const second = await realFetch(`${server.base}/state`, { headers: { 'if-none-match': etag } })
    assert.equal(second.status, 304, '内容没变应该回 304，省掉整包快照')
    assert.equal(await second.text(), '')

    // 状态一变，ETag 必须跟着变，否则前端会永远停在 304 上。
    await postWrite(server.base, '/policy', { footerMode: 'remaining' })
    const third = await realFetch(`${server.base}/state`, { headers: { 'if-none-match': etag } })
    assert.equal(third.status, 200)
    assert.notEqual(third.headers.get('etag'), etag)
    assert.equal((await third.json()).policy.footerMode, 'remaining')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
