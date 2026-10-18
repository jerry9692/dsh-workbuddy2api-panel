/**
 * client/client.js 的冒烟测试。
 *
 * 不装浏览器、不装 react-dom：用一个极小的 React 替身把 bundle 跑起来，
 * 检查 ModuleLoader 契约（id / exports）、插槽注册参数，以及组件能否在
 * 「没有任何数据」和「有完整数据」两种状态下渲染而不炸。
 *
 * 运行：node --test（在插件根目录，自动发现 tests/*.test.mjs）
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const BUNDLE = new URL('../client/client.js', import.meta.url)

/**
 * 极简 React 替身：createElement 返回可遍历的普通对象，useState 按调用顺序
 * 从预设队列里取值（组件里的 useState 顺序是固定的，这样就能把任意快照
 * 喂进渲染而不用真的跑一次 effect）。
 * @param initialStates - 按 useState 调用顺序排列的预设值。
 * @returns 替身模块。
 */
function makeReact(initialStates = []) {
  const Fragment = Symbol('Fragment')
  const queue = [...initialStates]
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.length <= 1 ? children[0] : children,
  })
  return {
    Fragment,
    createElement,
    useState: (initial) => [queue.length > 0 ? queue.shift() : typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
}

/**
 * 有状态的 React 替身：`useState` 真的会触发重渲染。
 *
 * 队列版（makeReact）测不出「数据变了界面跟不跟」这类问题，而徽标显示方式
 * 改完不生效正是这种 bug，所以这里单独做一份带 state 的。
 */
function makeStatefulReact() {
  const Fragment = Symbol('Fragment')
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.length <= 1 ? children[0] : children,
  })
  const api = {
    Fragment,
    createElement,
    __active: null,
    useState(initial) {
      const state = api.__active
      const index = state.cursor++
      if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        state.slots[index],
        (next) => {
          state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next
          state.rerender()
        },
      ]
    },
    useEffect(fn) {
      const state = api.__active
      state.cursor++
      if (state.phase === 'mount') state.effects.push(fn)
    },
    useLayoutEffect(fn) {
      api.useEffect(fn)
    },
    useMemo(factory) {
      api.__active.cursor++
      return factory()
    },
    useCallback(fn) {
      api.__active.cursor++
      return fn
    },
    useRef(value) {
      const state = api.__active
      const index = state.cursor++
      if (!(index in state.slots)) state.slots[index] = { current: value }
      return state.slots[index]
    },
    /** 挂载组件：返回的对象上 `.tree` 始终是最新一次渲染结果。 */
    __mount(component, props) {
      const state = { slots: [], cursor: 0, effects: [], cleanups: [], phase: 'mount', tree: null }
      state.rerender = () => {
        api.__active = state
        state.cursor = 0
        state.phase = 'update'
        state.tree = component(props)
      }
      api.__active = state
      state.tree = component(props)
      state.phase = 'update'
      for (const fn of state.effects) {
        const cleanup = fn()
        if (typeof cleanup === 'function') state.cleanups.push(cleanup)
      }
      return state
    },
  }
  return api
}

/** 等一轮微任务，让 effect 里的 await 落地。 */
function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** primitives 替身：只标记类型，方便断言。 */
function makePrimitives() {
  // createElement 不会调用组件函数，所以给替身挂一个标签，断言时按标签找。
  const make = (tag) => {
    const component = (props) => ({ type: `primitive:${tag}`, props: props ?? {}, children: undefined })
    component.primitiveTag = tag
    return component
  }
  return {
    Button: make('Button'),
    Switch: make('Switch'),
    Checkbox: make('Checkbox'),
    Input: make('Input'),
    Tag: make('Tag'),
    Pill: make('Pill'),
  }
}

/**
 * 用假 window/require 执行客户端 bundle，返回注册结果与插槽注册信息。
 * @param initialStates - 喂给组件 useState 的预设值。
 * @returns `{ entry, exports, ctx, registrations, dictionaries }`。
 */
async function loadBundle(initialStates = [], reactImpl = null) {
  const code = await readFile(BUNDLE, 'utf8')
  const modules = {
    react: reactImpl ?? makeReact(initialStates),
    '@deepseek-ai/dsh-client-ui-primitives': makePrimitives(),
  }
  const require = (id) => {
    if (!(id in modules)) throw new Error(`未预期的模块请求：${id}`)
    return modules[id]
  }
  let entry
  const window = {
    __ModuleLoader__: {
      load: (value) => {
        entry = value
      },
    },
  }
  new Function('window', 'require', code)(window, require)
  assert.ok(entry !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load')
  const exports = entry.factory(require)

  const registrations = []
  const dictionaries = []
  const ctx = {
    locale: {
      register: (ns, dict) => {
        dictionaries.push({ ns, dict })
        return () => {}
      },
      bind: (ns) => (key) => {
        const found = dictionaries.find((item) => item.ns === ns)
        return found?.dict.zh?.[key] ?? key
      },
    },
    effect: (fn) => {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    slots: {
      inject: (name, cb) => {
        cb()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { entry, exports, ctx, registrations, dictionaries }
}

/** 把 createElement 的树摊平成文本，便于断言。 */
function flatten(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join(' ')
  const parts = []
  if (node.children !== undefined) parts.push(flatten(node.children))
  if (node.props !== undefined) {
    for (const value of Object.values(node.props)) {
      if (typeof value === 'string' || typeof value === 'number') parts.push(String(value))
    }
  }
  return parts.join(' ')
}

/** 收集树里所有元素节点，便于按类型断言。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  out.push(node)
  if (node.children !== undefined) collect(node.children, out)
  return out
}

/** 一份「已连接且有数据」的快照，字段与 lib/index.js 的 snapshot() 对齐。 */
function sampleSnapshot() {
  const model = (over) => ({
    realm: 'cn',
    realmLabel: '国内版',
    rate: '',
    promoLabel: '',
    promoFactor: '',
    efforts: [],
    canDisableThinking: false,
    defaultEffort: '',
    contextWindow: 1000000,
    maxTokens: 128000,
    vendor: '',
    tags: [],
    description: '',
    supportsImages: false,
    supportsToolCall: true,
    enabled: true,
    selectedEfforts: null,
    ...over,
  })
  return {
    panelUrl: 'http://192.168.1.10:7863',
    baseUrl: 'http://192.168.1.10:7863',
    apiKeyEnv: 'WORKBUDDY2API_API_KEY',
    providerEntry: 'llm-pi-ai',
    routeKey: 'workbuddy2api',
    sync: true,
    intervalSeconds: 120,
    counts: { total: 3, enabled: 2, cn: 2, global: 1 },
    models: [
      model({
        id: 'cn:kimi-k3-1',
        name: 'Kimi-K3 1.6T',
        displayName: 'Kimi-K3 1.6T · 国内版 · ×0.05',
        rate: '0.05',
        efforts: ['low', 'high'],
        canDisableThinking: true,
        defaultEffort: 'high',
        contextWindow: 256000,
        maxTokens: 32000,
        supportsImages: true,
      }),
      model({
        id: 'cn:glm-5.3',
        name: 'GLM-5.3',
        displayName: 'GLM-5.3 · 国内版 · ×0.1',
        rate: '0.1',
        promoLabel: '限时',
        promoFactor: '0.8',
        enabled: false,
      }),
      model({
        id: 'global:gpt-6-astra',
        realm: 'global',
        realmLabel: '国际版',
        name: 'GPT-6 Astra',
        displayName: 'GPT-6 Astra · 国际版 · ×1',
        rate: '1',
        efforts: ['high'],
        defaultEffort: 'high',
        selectedEfforts: ['high'],
      }),
    ],
    panelVersion: '1.13.0-panel',
    // v0.2.0 起宿主会返回 policy；没有这块时前端会整块藏起来（兼容未重启的老宿主）。
    policy: { newModelPolicy: 'select', lowCreditMark: true, retireHours: 24, thresholds: { lowCredits: 50, expiryDays: 3, unreachablePolls: 5 } },
    alerts: [],
    newModels: [],
    retired: [],
    packages: null,
    lastSyncAt: Date.now() - 60_000,
    lastSyncCount: 3,
    lastSyncError: '',
    lastError: '',
    modelsFetchedAt: Date.now(),
    overviewFetchedAt: Date.now(),
    usageFetchedAt: Date.now(),
    quota: {
      realms: [
        { realm: 'cn', label: '国内版', accounts: 2, healthy: 1, cooling: 1, disabled: 0, credits: 1500, creditsTotal: 3000 },
        { realm: 'global', label: '国际版', accounts: 1, healthy: 1, cooling: 0, disabled: 0, credits: 300, creditsTotal: 300 },
      ],
      total: { accounts: 3, healthy: 2, cooling: 1, disabled: 0, credits: 1800, creditsTotal: 3300 },
      version: '1.13.0-panel',
      uptimeSec: 100,
      authRequired: true,
      redisMode: false,
    },
    usage: {
      windowFrom: '',
      windowTo: '',
      generated: '',
      totals: { requests: 120, errors: 1, tokens: 3_000_000, credits: 45.5, cacheHitRate: 0.42, avgLatencyMs: 1830 },
      realms: [],
      byModel: [
        { key: 'global:gpt-6-astra', realm: 'global', requests: 5, tokens: 2000, credits: 9, errors: 0 },
        { key: 'cn:kimi-k3-1', realm: 'cn', requests: 10, tokens: 1000, credits: 1, errors: 0 },
      ],
    },
    accounts: [
      { uid: 'a', nickname: '账号一', realm: 'cn', credits: 1000, creditsTotal: 2000, cooling: false, coolRemainingSec: 0, disabled: false, disabledReason: '', inFlight: 0, successCount: 3, errTotal: 0, enterprise: false },
      { uid: 'b', nickname: '账号二', realm: 'cn', credits: 500, creditsTotal: 1000, cooling: true, coolRemainingSec: 120, disabled: false, disabledReason: '', inFlight: 0, successCount: 1, errTotal: 2, enterprise: false },
    ],
  }
}

test('bundle 暴露 ModuleLoader 契约与必需的服务声明', async () => {
  const { entry, exports } = await loadBundle()
  assert.equal(entry.id, 'dsh-workbuddy2api-panel')
  assert.equal(typeof entry.factory, 'function')
  assert.equal(exports.NS, 'workbuddyPanel')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

test('apply 注册中英文字典与 settings.section 分区', async () => {
  const { exports, ctx, registrations, dictionaries } = await loadBundle()
  exports.apply(ctx)
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'workbuddyPanel')
  assert.equal(dictionaries[0].dict.zh.nav, 'WorkBuddy 面板')
  assert.equal(dictionaries[0].dict.en.nav, 'WorkBuddy Panel')
  // 中英文字典的键必须完全对齐，否则切换语言会出现空标签。
  assert.deepEqual(Object.keys(dictionaries[0].dict.zh).sort(), Object.keys(dictionaries[0].dict.en).sort())

  // 两个注册点：设置页分区 + 侧边栏底部徽标。
  assert.equal(registrations.length, 2)
  const { options, component } = registrations[0]
  const footer = registrations[1]
  assert.equal(footer.options.name, 'sidebar.footer.action')
  assert.equal(footer.options.id, 'workbuddy-quota')
  assert.equal(typeof footer.options.order, 'number')
  assert.equal(footer.options.label(), 'WorkBuddy 额度')
  assert.equal(typeof footer.component, 'function')
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'workbuddy')
  assert.equal(options.locale, 'workbuddyPanel')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.label(), 'WorkBuddy 面板')
  assert.deepEqual(Object.keys(options.inject()), ['t'])
  assert.equal(typeof component, 'function')
})

test('空状态下渲染不崩，并给出连接引导', async () => {
  const { exports, ctx, registrations } = await loadBundle()
  exports.apply(ctx)
  const element = registrations[0].component({})
  assert.equal(typeof element.type, 'function')
  const text = flatten(element.type({ ...element.props, t: (key) => `#${key}` }))
  assert.ok(text.includes('#title'), '应渲染标题')
  assert.ok(text.includes('#noModels'), '应提示先连接面板')
  assert.ok(text.includes('#panelUrl'), '应出现地址输入')
  assert.ok(text.includes('#probe'), '应提供自动探测')
})

test('有数据时渲染额度、模型分组与用量表', async () => {
  const snap = sampleSnapshot()
  // useState 调用顺序：snap, error, notice, busy, url, key, hours, probe。
  const { exports, ctx, registrations } = await loadBundle([snap, '', '', '', '', '', 72, null])
  exports.apply(ctx)
  const element = registrations[0].component({})
  const tree = element.type({ ...element.props, t: (key) => `#${key}` })
  const text = flatten(tree)
  const nodes = collect(tree)

  // 顶部状态与版本
  assert.ok(text.includes('#connected'), '应显示已连接')
  assert.ok(text.includes('v1.13.0-panel'), '应显示面板版本')
  // 额度：国内 1.5k、国际 300
  assert.ok(text.includes('1,500'), '应显示国内版剩余积分')
  assert.ok(text.includes('300'), '应显示国际版剩余积分')
  // 模型分组标题与倍率
  assert.ok(text.includes('#cn'), '应有国内版分组')
  assert.ok(text.includes('#global'), '应有国际版分组')
  assert.ok(text.includes('Kimi-K3 1.6T'), '应列出模型名')
  assert.ok(text.includes('×0.05'), '应显示倍率')
  assert.ok(text.includes('#efforts'), '应显示档位列')
  // 用量表
  assert.ok(text.includes('global:gpt-6-astra'), '应列出模型用量行')
  assert.ok(text.includes('#topModels'), '应显示用量表标题')
  // 账号行
  assert.ok(text.includes('账号一'), '应列出账号')
  assert.ok(text.includes('2m'), '冷却剩余时间应换算成分钟')

  // 每个模型一行，且开关状态与快照一致。
  const checkboxes = nodes.filter((node) => node.type?.primitiveTag === 'Checkbox')
  assert.equal(checkboxes.length, 3)
  assert.deepEqual(checkboxes.map((node) => node.props.checked), [true, false, true])

  // 档位 chip 只出现在有档位的模型上（2 + 1），另有 3 个统计窗口 chip、
  // 3 个「新模型策略」chip 和 1 个「额度不足标注」开关。
  const chips = nodes.filter((node) => typeof node.props?.active === 'boolean')
  assert.equal(chips.length, 14, '3 档位 + 3 窗口 + 3 策略 + 1 标注开关 + 4 徽标方式')
  assert.deepEqual(
    chips.slice(0, 3).map((node) => node.children),
    ['low', 'high', 'high'],
  )
  // 第一个模型的档位默认全选（selectedEfforts 为 null 时按 efforts 全选）。
  assert.deepEqual(chips.slice(0, 3).map((node) => node.props.active), [true, true, true])
  // 策略 chip：默认「自动勾选」是亮的，额度标注默认开。
  assert.deepEqual(chips.slice(6, 9).map((node) => node.props.active), [true, false, false])
  assert.equal(chips[9].props.active, true)

  // 分组计数：国内 1/2、国际 1/1。
  assert.ok(text.includes('1/2'), '国内版应显示 1/2')
  assert.ok(text.includes('1/1'), '国际版应显示 1/1')
})

test('错误状态会把错误文本渲染出来', async () => {
  const { exports, ctx, registrations } = await loadBundle([null, 'API Key 无效或缺失', '', '', '', '', 72, null])
  exports.apply(ctx)
  const element = registrations[0].component({})
  const text = flatten(element.type({ ...element.props, t: (key) => `#${key}` }))
  assert.ok(text.includes('API Key 无效或缺失'))
  assert.ok(text.includes('#error'))
})

test('老宿主（快照里没有 policy）不渲染策略卡片，但告警条照常显示', async () => {
  const snap = sampleSnapshot()
  snap.alerts = [{ key: 'auth', level: 'error', title: '面板 API Key 失效', detail: 'HTTP 401' }]
  delete snap.policy
  const { exports, ctx, registrations } = await loadBundle([snap, '', '', '', '', '', 72, null])
  exports.apply(ctx)
  const element = registrations[0].component({})
  const text = flatten(element.type({ ...element.props, t: (key) => `#${key}` }))
  assert.ok(text.includes('面板 API Key 失效'), '告警条应渲染')
  assert.ok(text.includes('HTTP 401'), '告警应带上细节')
  assert.ok(!text.includes('#policyTitle'), '老宿主没有 policy 字段，不该渲染策略卡片')
  assert.ok(!text.includes('#clearButton'), '也不该渲染清除按钮（点了会 404）')
})

test('侧边栏徽标：宽窄两种形态都能渲染，带余额与状态点', async () => {
  const snap = sampleSnapshot()
  // useState 顺序：snap, open, anchor。
  const { exports, ctx, registrations } = await loadBundle([snap, false, null])
  exports.apply(ctx)
  const register = registrations[1].component
  // 注册时包了一层：先拿元素，再渲染它的 type。
  const render = (wide) => {
    const element = register({ wide })
    return flatten(element.type(element.props))
  }

  const wide = render(true)
  assert.ok(wide.includes('WB'), '宽形态应显示 WB 前缀')
  assert.ok(wide.includes('1,800'), '应显示剩余积分合计（千分位）')
  assert.ok(wide.includes('WorkBuddy 额度'), 'title 用本地化标签')

  const narrow = render(false)
  assert.ok(narrow.includes('WB'), '窄形态（56px 轨道）也要有内容')
  assert.ok(!narrow.includes('1,800'), '窄形态不塞数字，避免挤爆')
})

test('侧边栏徽标：按设置里的显示方式渲染', async () => {
  const cases = [
    ['ratio', '1,800 / 3,300'],
    ['realms', '国内 1,500'],
    ['realms', '国际 300'],
    ['remaining', '1,800'],
  ]
  for (const [mode, expected] of cases) {
    const snap = sampleSnapshot()
    snap.policy = { ...(snap.policy ?? {}), footerMode: mode }
    const { exports, ctx, registrations } = await loadBundle([snap, false, null])
    exports.apply(ctx)
    const element = registrations[1].component({ wide: true })
    const text = flatten(element.type(element.props))
    assert.ok(text.includes(expected), `${mode} 应包含「${expected}」，实际：${text}`)
  }
})

test('改完徽标显示方式，侧边栏徽标立刻跟着变（不等 60 秒轮询）', async () => {
  const react = makeStatefulReact()
  const snap = sampleSnapshot()
  snap.policy = { footerMode: 'ratio', footerDot: true }
  const realDocument = globalThis.document
  globalThis.document = { baseURI: 'http://127.0.0.1:19387/' }
  globalThis.fetch = async () => new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } })
  let footer = null
  try {
    const { exports, ctx, registrations } = await loadBundle([], react)
    exports.apply(ctx)
    // 注册时包了一层 (ownerProps) => h(WorkBuddyFooter, {...})，要挂的是内层组件。
    const wrapper = registrations[1].component({ wide: true })
    footer = react.__mount(wrapper.type, wrapper.props)
    // 设置页 apply 的那一下：广播快照。
    exports.__store.set(snap)
    await tick()
    assert.ok(flatten(footer.tree).includes('1,800 / 3,300'), '初始应是剩余 / 总额')

    // 用户在设置页点了「分域显示」。
    exports.__store.set({ ...snap, policy: { ...snap.policy, footerMode: 'realms' } })
    await tick()
    const text = flatten(footer.tree)
    assert.ok(text.includes('国内 1,500'), `应立刻变成分域显示，实际：${text}`)
    assert.ok(!text.includes('1,800 / 3,300'), '不该还留着旧文案')

    // 再点「不显示」。
    exports.__store.set({ ...snap, policy: { ...snap.policy, footerMode: 'hidden' } })
    await tick()
    assert.equal(footer.tree, null, '隐藏后不渲染任何东西')
  } finally {
    for (const cleanup of footer?.cleanups ?? []) cleanup()
    delete globalThis.fetch
    globalThis.document = realDocument
  }
})

test('设置页加载完会把快照广播出去（徽标不用自己再等一轮）', async () => {
  const react = makeStatefulReact()
  const snap = sampleSnapshot()
  snap.policy = { footerMode: 'realms', footerDot: true }
  const realDocument = globalThis.document
  globalThis.document = { baseURI: 'http://127.0.0.1:19387/' }
  globalThis.fetch = async () => new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const { exports, ctx, registrations } = await loadBundle([], react)
    exports.apply(ctx)
    const wrapper = registrations[0].component({})
    const panel = react.__mount(wrapper.type, wrapper.props)
    await tick(5)
    assert.equal(exports.__store.get()?.routeKey, snap.routeKey, '设置页 apply 之后应已广播')
    for (const cleanup of panel.cleanups) cleanup()
  } finally {
    delete globalThis.fetch
    globalThis.document = realDocument
  }
})

test('侧边栏徽标：hidden 时不渲染任何东西', async () => {
  const snap = sampleSnapshot()
  snap.policy = { ...(snap.policy ?? {}), footerMode: 'hidden' }
  const { exports, ctx, registrations } = await loadBundle([snap, false, null])
  exports.apply(ctx)
  const element = registrations[1].component({ wide: true })
  assert.equal(element.type(element.props), null)
})

test('接口路径保留查询串（用量窗口靠它传）', async () => {
  const { exports } = await loadBundle()
  const realDocument = globalThis.document
  globalThis.document = { baseURI: 'http://127.0.0.1:19387/settings' }
  try {
    // 只取 pathname 会把 ?hours=24 丢掉，后端回退到默认 72 小时，
    // 界面上却还写着 24h —— 数字和标签对不上。
    assert.equal(exports.__apiPath('usage?hours=24'), '/workbuddy-panel/api/usage?hours=24')
    assert.equal(exports.__apiPath('/state'), '/workbuddy-panel/api/state')
  } finally {
    if (realDocument === undefined) delete globalThis.document
    else globalThis.document = realDocument
  }
})

test('告警按当前语言渲染（服务端只给 key + 参数）', async () => {
  const zh = {
    alertLowCreditsTitle: '{realm}额度不足',
    alertLowCreditsDetail: '剩余 {remaining} 积分（阈值 {threshold}）',
    realmCn: '国内版',
    realmGlobal: '国际版',
    alertJoin: '：',
  }
  const en = {
    alertLowCreditsTitle: 'Low {realm} credits',
    alertLowCreditsDetail: '{remaining} credits left (threshold {threshold})',
    realmCn: 'China',
    realmGlobal: 'Global',
    alertJoin: ': ',
  }
  const render = async (dictionary) => {
    const snap = sampleSnapshot()
    snap.alerts = [
      {
        key: 'low-credits:cn',
        level: 'warn',
        // 中文兜底文案也在，但界面应该优先用词典 + 参数。
        title: '国内版额度不足',
        detail: '剩余 30 积分（阈值 50）',
        titleKey: 'alertLowCreditsTitle',
        detailKey: 'alertLowCreditsDetail',
        params: { realm: 'cn', realmLabel: '国内版', remaining: 30, threshold: 50 },
      },
    ]
    // 每份快照都要重新 loadBundle：队列版 React 的 useState 只发一轮。
    const { exports, ctx, registrations } = await loadBundle([snap, '', '', '', '', '', 72, null])
    exports.apply(ctx)
    const element = registrations[0].component({})
    return flatten(element.type({ ...element.props, t: (key) => dictionary[key] ?? `#${key}` }))
  }

  const zhText = await render(zh)
  assert.ok(zhText.includes('国内版额度不足：剩余 30 积分（阈值 50）'), `中文渲染不对：${zhText}`)

  const enText = await render(en)
  assert.ok(enText.includes('Low China credits: 30 credits left (threshold 50)'), `英文渲染不对：${enText}`)
  assert.ok(!enText.includes('额度不足'), '英文界面不该出现中文告警')
})

test('档位 chip 带 aria-pressed，屏幕阅读器能读出选中状态', async () => {
  const { exports } = await loadBundle()
  assert.equal(exports.__Chip({ active: true, children: 'high' }).props['aria-pressed'], true)
  assert.equal(exports.__Chip({ active: false, children: 'low' }).props['aria-pressed'], false)
})
