/**
 * workbuddy2api-panel 的纯函数层：URL 归一、模型条目 → DSH 模型档案、额度/用量归一。
 *
 * 这一层不碰 cordis、不碰网络，只做数据变换，方便单独跑测试。
 * 字段定义紧跟面板源码（github.com/linguo2625469/workbuddy2api-panel）：
 *   - internal/panel/panel.go  handleModels 写出的 panelModelEntry
 *   - internal/pool/entry.go   pool.Status（账号与剩余积分）
 *   - internal/usage/usage.go  usage.Snapshot（用量聚合）
 */

/** 面板默认监听端口。 */
export const DEFAULT_PANEL_PORT = 7863

/** 面板模型 id 的域前缀 → 中文标签。 */
const REALM_LABELS = { cn: '国内版', global: '国际版' }

/**
 * 把用户输入的地址归一成面板根地址（不带尾斜杠、不带 /v1、不带 /panel）。
 *
 * 用户从各处抄来的地址形态不一：`192.168.1.10:7863`、`http://host:7863/v1`、
 * `http://host:7863/panel/`。DSH 侧要的是面板根，再各自拼 `/panel/api/*`。
 * @param input - 用户输入或配置里的原始地址。
 * @returns 归一后的根地址；无法解析时返回空串。
 */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string') return ''
  let text = input.trim()
  if (text === '') return ''
  // 没写协议：面板是 http 服务，补 http:// 比猜 https 更可能对。
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  let path = url.pathname.replace(/\/+$/, '')
  // 用户常把 OpenAI 端点或面板页直接贴进来，逐个剥掉。
  for (const suffix of ['/v1', '/panel']) {
    if (path.toLowerCase().endsWith(suffix)) path = path.slice(0, -suffix.length)
  }
  path = path.replace(/\/+$/, '')
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${url.hostname}${port}${path}`
}

/**
 * 从模型 id 取出域前缀。
 * @param id - 面板模型 id，形如 `cn:deepseek-v4.1-flash` 或 `global:gpt-6-astra`。
 * @returns `'cn'`、`'global'`，或无法识别时的空串。
 */
export function realmOf(id) {
  if (typeof id !== 'string') return ''
  const colon = id.indexOf(':')
  if (colon <= 0) return ''
  const realm = id.slice(0, colon).toLowerCase()
  return realm === 'cn' || realm === 'global' ? realm : ''
}

/** 域的中文标签。 */
export function realmLabel(realm) {
  return REALM_LABELS[realm] ?? '未知'
}

/** 去掉面板倍率原文里的前缀/后缀 `x`：`x0.05` / `0.05x` → `0.05`。 */
export function rateText(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^[x×]\s*/i, '').replace(/\s*[x×]$/i, '')
}

/**
 * 面板给的倍率是否真的是倍率。
 *
 * `credits` 是面板展示用的原文串（"x0.05"），个别模型是 "-" 或空。
 * @returns 可展示的倍率文本；没有时返回空串。
 */
export function modelRate(model) {
  if (model === null || typeof model !== 'object') return ''
  const promo = rateText(model.promo_credits)
  if (promo !== '') return promo
  return rateText(model.credits)
}

/**
 * 面板模型条目 → DSH 选择器里显示的模型名。
 *
 * 倍率写进名字是刻意的：DSH 的模型选择器只显示 `name`，没有第二行副标题，
 * 想让用户在选择器里直接看到价格差异，只能写进名字。
 * @param model - 面板模型条目。
 * @returns 显示名，形如 `Kimi-K3 1.6T · 国内版 · ×0.05`。
 */
export function modelDisplayName(model) {
  const label = typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : String(model.id ?? '')
  const realm = realmOf(model.id)
  const rate = modelRate(model)
  const parts = [label]
  if (realm !== '') parts.push(realmLabel(realm))
  if (rate !== '') parts.push(`×${rate}`)
  // 状态后缀放在最后：DSH 的选择器只显示 name，这是唯一能让用户看见状态的地方。
  if (model?.retired === true) parts.push('已下架')
  else if (model?.lowCredits === true) parts.push('额度不足')
  return parts.join(' · ')
}

/**
 * 面板 supported_efforts → DSH 的 `reasoningEfforts`。
 *
 * DSH（pi-ai）的等级键是 off/minimal/low/medium/high/xhigh/max，值是该等级在
 * 协议里发送的原文。面板的值域与 DSH 同名（low/medium/high/xhigh/max），
 * 所以这里原样一一对应，不做改名。`off` 只在面板明确允许关闭思考时声明：
 * 面板的 payload.go 会把显式 `reasoning_effort:"off"` 抬到该模型最低支持档，
 * 因此 `off` 发的是字符串而不是 null（null 会被面板补成「开启思考」）。
 * @param model - 面板模型条目。
 * @returns 可直接写进 PiAiModelProfile.reasoningEfforts 的对象，或 `false`（非推理模型）。
 */
export function modelReasoningEfforts(model) {
  const declared = Array.isArray(model?.supported_efforts) ? model.supported_efforts : []
  const levels = []
  for (const raw of declared) {
    if (typeof raw !== 'string') continue
    const level = raw.trim().toLowerCase()
    if (level === '' || level === 'off' || level === 'minimal') continue
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) continue
    if (!levels.includes(level)) levels.push(level)
  }
  const efforts = {}
  // off 必须排在最前，选择器里才按「关 → 低 → 高」排列。
  if (model?.can_disable_thinking === true) efforts.off = 'off'
  for (const level of levels) efforts[level] = level
  if (Object.keys(efforts).length === 0) return model?.supports_reasoning === true ? undefined : false
  // 只有 off 没有正档 → DSH 会拒绝这份档案（必须至少一个非 off 档）。
  if (!levels.length) return false
  return efforts
}

/**
 * 应用用户对该模型的档位裁剪：用户关掉的档位不再出现在选择器里。
 * @param efforts - {@link modelReasoningEfforts} 的结果。
 * @param selected - 用户选中的档位列表；缺省表示全选。
 * @returns 裁剪后的 reasoningEfforts，或原值。
 */
export function clampEfforts(efforts, selected) {
  if (efforts === false || efforts === undefined) return efforts
  if (!Array.isArray(selected) || selected.length === 0) return efforts
  const kept = {}
  for (const [level, wire] of Object.entries(efforts)) {
    if (level === 'off' || selected.includes(level)) kept[level] = wire
  }
  // 裁剪后没有正档就不能写成对象，退回「全支持」，避免整份档案校验失败。
  if (!Object.keys(kept).some((level) => level !== 'off')) return efforts
  return kept
}

/**
 * 面板模型条目 → DSH 的 PiAiModelProfile。
 * @param model - 面板模型条目。
 * @param options - `enabled`、用户裁剪的 `efforts`。
 * @returns 模型档案；无法构成有效档案时返回 undefined。
 */
export function toModelProfile(model, options = {}) {
  if (model === null || typeof model !== 'object') return undefined
  const id = typeof model.id === 'string' ? model.id.trim() : ''
  if (id === '') return undefined
  const profile = {
    id,
    name: modelDisplayName(model),
  }
  const context = Number(model.context_length)
  if (Number.isFinite(context) && context > 0) profile.contextWindow = Math.round(context)
  const maxTokens = Number(model.max_output_tokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) profile.maxTokens = Math.round(maxTokens)
  if (model.supports_images === true) profile.input = ['text', 'image']
  const efforts = clampEfforts(modelReasoningEfforts(model), options.efforts)
  if (efforts !== undefined) profile.reasoningEfforts = efforts
  return profile
}

/**
 * 面板模型列表 + 用户选择 → 写进 llm-pi-ai 路由的 `models` 数组。
 *
 * 顺序固定：国内版在前、国际版在后，各自保持面板返回顺序（面板已按默认/热度排过）。
 * @param models - 面板模型条目数组。
 * @param selection - `{ [id]: { enabled, efforts } }`。
 * @returns 模型档案数组。
 */
export function buildRouteModels(models, selection) {
  const rows = Array.isArray(models) ? models : []
  const picked = []
  for (const realm of ['cn', 'global']) {
    for (const model of rows) {
      if (realmOf(model?.id) !== realm) continue
      const id = model.id
      const choice = selection?.[id]
      if (choice !== undefined && choice.enabled === false) continue
      const profile = toModelProfile(model, { efforts: choice?.efforts })
      if (profile !== undefined) picked.push(profile)
    }
  }
  // 面板里出现了既非 cn: 也非 global: 的 id（未来可能的第三域）也照收，不静默丢模型。
  for (const model of rows) {
    const realm = realmOf(model?.id)
    if (realm === 'cn' || realm === 'global') continue
    const choice = selection?.[model?.id]
    if (choice !== undefined && choice.enabled === false) continue
    const profile = toModelProfile(model, { efforts: choice?.efforts })
    if (profile !== undefined) picked.push(profile)
  }
  return picked
}

/**
 * 面板模型条目 → 面板/插件 UI 用的展示行（比 PiAiModelProfile 多带倍率与档位原文）。
 * @param model - 面板模型条目。
 * @param selection - 用户选择。
 * @returns 展示行。
 */
export function toModelRow(model, selection) {
  const id = typeof model?.id === 'string' ? model.id : ''
  const realm = realmOf(id)
  const choice = selection?.[id]
  const efforts = modelReasoningEfforts(model)
  return {
    id,
    realm,
    realmLabel: realmLabel(realm),
    name: typeof model?.name === 'string' && model.name !== '' ? model.name : id,
    displayName: modelDisplayName(model),
    rate: modelRate(model),
    promoLabel: typeof model?.promo_label === 'string' ? model.promo_label : '',
    promoFactor: typeof model?.promo_factor === 'string' ? model.promo_factor : '',
    efforts: efforts === false || efforts === undefined ? [] : Object.keys(efforts).filter((level) => level !== 'off'),
    canDisableThinking: model?.can_disable_thinking === true,
    defaultEffort: typeof model?.default_effort === 'string' ? model.default_effort : '',
    contextWindow: Number(model?.context_length) || 0,
    maxTokens: Number(model?.max_output_tokens) || 0,
    vendor: typeof model?.vendor === 'string' ? model.vendor : '',
    tags: Array.isArray(model?.tags) ? model.tags.filter((tag) => typeof tag === 'string') : [],
    description: typeof model?.description === 'string' ? model.description : '',
    supportsImages: model?.supports_images === true,
    supportsToolCall: model?.supports_tool_call === true,
    enabled: choice === undefined ? true : choice.enabled !== false,
    selectedEfforts: Array.isArray(choice?.efforts) ? choice.efforts : null,
    /** 面板已下架，还在宽限期里。 */
    retired: model?.retired === true,
    /** 该域额度见底，显示名带「额度不足」。 */
    lowCredits: model?.lowCredits === true,
  }
}

/**
 * 面板 overview（账号池状态）→ 按域汇总的额度视图。
 *
 * 面板的 `accounts` 每项是 pool.Status：`credits` 是剩余积分（int64），
 * `credits_total` 是总额，`realm` 区分国内/国际。
 * @param overview - GET /panel/api/overview 的响应体。
 * @returns 汇总结果；无账号时各项为 0。
 */
export function summarizeOverview(overview) {
  const accounts = Array.isArray(overview?.accounts) ? overview.accounts : []
  const realms = {
    cn: { realm: 'cn', label: realmLabel('cn'), accounts: 0, healthy: 0, cooling: 0, disabled: 0, credits: 0, creditsTotal: 0 },
    global: { realm: 'global', label: realmLabel('global'), accounts: 0, healthy: 0, cooling: 0, disabled: 0, credits: 0, creditsTotal: 0 },
  }
  const total = { accounts: 0, healthy: 0, cooling: 0, disabled: 0, credits: 0, creditsTotal: 0 }
  for (const account of accounts) {
    // 面板一定给 realm，缺了就归到「未知」而不是猜成国内版。
    const realm = typeof account?.realm === 'string' && account.realm !== '' ? account.realm : 'unknown'
    const bucket = realms[realm] ?? (realms[realm] = {
      realm,
      label: realmLabel(realm),
      accounts: 0,
      healthy: 0,
      cooling: 0,
      disabled: 0,
      credits: 0,
      creditsTotal: 0,
    })
    const credits = Number(account?.credits) || 0
    const creditsTotal = Number(account?.credits_total) || 0
    bucket.accounts += 1
    bucket.credits += credits
    bucket.creditsTotal += creditsTotal
    total.accounts += 1
    total.credits += credits
    total.creditsTotal += creditsTotal
    const disabled = account?.disabled === true || account?.paused === true
    if (disabled) {
      bucket.disabled += 1
      total.disabled += 1
      continue
    }
    if (account?.cooling === true) {
      bucket.cooling += 1
      total.cooling += 1
      continue
    }
    bucket.healthy += 1
    total.healthy += 1
  }
  return {
    realms: Object.values(realms),
    total,
    version: typeof overview?.version === 'string' ? overview.version : '',
    uptimeSec: Number(overview?.uptime_sec) || 0,
    authRequired: overview?.auth_required === true,
    redisMode: overview?.redis_mode === true,
  }
}

/**
 * 面板 usage 快照 → 插件 UI 直接可用的用量视图。
 *
 * 面板的 Snapshot.by_model 是 []KeyedAgg{key, realm, Agg}，Agg 里
 * requests / total_tokens / credits 是我们关心的三列。
 * @param snapshot - GET /panel/api/usage 的响应体。
 * @param limit - by_model 取前多少行。
 * @returns 归一后的用量视图。
 */
export function summarizeUsage(snapshot, limit = 12) {
  const totals = snapshot?.totals ?? {}
  const byModel = Array.isArray(snapshot?.by_model) ? snapshot.by_model : []
  const byRealm = Array.isArray(snapshot?.by_realm) ? snapshot.by_realm : []
  const rows = byModel
    .map((row) => ({
      key: typeof row?.key === 'string' ? row.key : '',
      realm: typeof row?.realm === 'string' ? row.realm : '',
      requests: Number(row?.requests) || 0,
      tokens: Number(row?.total_tokens) || 0,
      credits: Number(row?.credits) || 0,
      errors: Number(row?.errors) || 0,
    }))
    .filter((row) => row.requests > 0 || row.tokens > 0)
    .sort((a, b) => b.credits - a.credits || b.requests - a.requests)
    .slice(0, limit)
  return {
    windowFrom: typeof snapshot?.window_from === 'string' ? snapshot.window_from : '',
    windowTo: typeof snapshot?.window_to === 'string' ? snapshot.window_to : '',
    generated: typeof snapshot?.generated === 'string' ? snapshot.generated : '',
    totals: {
      requests: Number(totals?.requests) || 0,
      errors: Number(totals?.errors) || 0,
      tokens: Number(totals?.total_tokens) || 0,
      credits: Number(totals?.credits) || 0,
      cacheHitRate: Number(totals?.cache_hit_rate) || 0,
      avgLatencyMs: Number(totals?.avg_latency_ms) || 0,
    },
    realms: byRealm.map((row) => ({
      realm: typeof row?.key === 'string' ? row.key : '',
      label: realmLabel(typeof row?.key === 'string' ? row.key : ''),
      requests: Number(row?.requests) || 0,
      tokens: Number(row?.total_tokens) || 0,
      credits: Number(row?.credits) || 0,
    })),
    byModel: rows,
  }
}

/**
 * 探测候选地址：当前配置、局域网常见地址、本机。
 *
 * 只是「候选清单」，实际能不能连通由 {@link probeBase} 判定。面板默认端口 7863，
 * 所以候选都带端口；用户自己的地址排在最前。
 * @param known - 已知/配置的地址。
 * @param hostHint - 从当前地址里取出的主机名（用于同主机不同端口的猜测）。
 * @returns 去重后的候选列表。
 */
/**
 * 解析「地址列表」文本：每行一个地址，可选第二个 token 是超时秒数。
 *
 *   http://192.168.1.10:7863
 *   https://nas.example.com/wb/  8
 *   # 井号开头是注释
 *
 * @param text - 多行文本。
 * @returns `[{ url, timeoutMs }]`，已归一化并去重；`timeoutMs` 为 0 表示用默认值。
 */
export function parseAddressLines(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const entries = []
  const seen = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [head, tail] = line.split(/\s+/)
    const url = normalizeBaseUrl(head)
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const seconds = Number(tail)
    const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.floor(seconds * 1000), 120000) : 0
    entries.push({ url, timeoutMs })
  }
  return entries
}

/** 把地址列表拼回文本（给设置页的 textarea 用）。 */
export function formatAddressLines(entries) {
  if (!Array.isArray(entries)) return ''
  return entries
    .map((entry) => {
      const url = typeof entry === 'string' ? entry : entry?.url
      const timeoutMs = typeof entry === 'string' ? 0 : Number(entry?.timeoutMs) || 0
      if (typeof url !== 'string' || url === '') return ''
      return timeoutMs > 0 ? `${url} ${timeoutMs / 1000}` : url
    })
    .filter((line) => line !== '')
    .join('\n')
}

export function probeCandidates(known, hostHint) {
  const hosts = []
  const push = (value) => {
    const normalized = normalizeBaseUrl(value)
    if (normalized !== '' && !hosts.includes(normalized)) hosts.push(normalized)
  }
  if (Array.isArray(known)) for (const value of known) push(value)
  else push(known)
  const host = typeof hostHint === 'string' ? hostHint.trim() : ''
  if (host !== '') push(`http://${host}:${DEFAULT_PANEL_PORT}`)
  push(`http://127.0.0.1:${DEFAULT_PANEL_PORT}`)
  push(`http://localhost:${DEFAULT_PANEL_PORT}`)
  return hosts
}

/**
 * 递归按键名排序后再序列化，用来比较「配置是否真的变了」。
 *
 * 直接 `JSON.stringify` 比不了：同一份配置从 YAML 读回来、再被我们写出去，
 * 字段顺序可能不同，字符串就不相等，于是每轮都白写一次。
 * @param value - 任意可序列化值。
 * @returns 键序稳定的 JSON 字符串。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * 判断 DSH 里这条 provider 是否已经是我们想要的样子。
 *
 * 只在完全一致时返回 true——不一致就重写，这样用户在 YAML 里手改过的内容
 * 会被下一轮同步纠正回来（插件接管这条路由，README 里写明了）。
 * @param current - 现有 provider 配置（可能缺失）。
 * @param target - 期望的 provider 配置。
 * @returns 是否已经一致。
 */
export function routeConfigMatches(current, target) {
  if (current === null || typeof current !== 'object') return false
  for (const key of Object.keys(target)) {
    if (canonicalJson(current[key]) !== canonicalJson(target[key])) return false
  }
  return true
}

/**
 * 算下一次轮询的间隔：连续失败时指数退避，上限 30 分钟。
 *
 * 面板/NAS 掉线时不该每 2 分钟硬撞一次，但也不能退到几小时才发现恢复。
 * @param baseSeconds - 用户设置的基准间隔（秒）。
 * @param failures - 连续失败次数。
 * @returns 间隔毫秒数。
 */
export function pollIntervalMs(baseSeconds, failures) {
  const base = Math.max(30, Number(baseSeconds) || 120) * 1000
  const steps = Math.min(Math.max(0, Math.floor(Number(failures) || 0)), 5)
  return Math.min(base * 2 ** steps, 30 * 60 * 1000)
}

/**
 * 把面板这一轮的模型清单和上一轮对齐，算出新增/下架/复活。
 *
 * 面板不返回某个模型时不能立刻删：正在用它的会话会直接报「模型不存在」。
 * 所以先把下架的模型放进 `retired` 宽限期（默认 24 小时）里继续保留，
 * 期间面板又把它放回来就自动复活。
 * @param panelModels - 面板本轮返回的模型数组。
 * @param previous - `{ lastIds, models, retired }`，上一轮的结果（`models` 用来保存下架模型的完整定义）。
 * @param now - 当前时间戳（毫秒）。
 * @param graceMs - 下架宽限期（毫秒）。
 * @returns `{ models, retired, added, removed, expired }`。
 */
export function reconcileModels(panelModels, previous, now, graceMs) {
  const models = Array.isArray(panelModels) ? panelModels : []
  const lastIds = Array.isArray(previous?.lastIds) ? previous.lastIds : []
  const retiredIn = previous?.retired !== null && typeof previous?.retired === 'object' ? previous.retired : {}
  const currentIds = new Set()
  for (const model of models) {
    if (typeof model?.id === 'string' && model.id !== '') currentIds.add(model.id)
  }
  const lastSet = new Set(lastIds)
  const retired = {}
  const expired = []
  // 1) 还在宽限期里的：面板又给了就复活，超时就真删。
  for (const [id, entry] of Object.entries(retiredIn)) {
    if (currentIds.has(id)) continue
    const at = Number(entry?.at) || 0
    if (now - at > graceMs) {
      expired.push(id)
      continue
    }
    retired[id] = entry
  }
  // 2) 这一轮新消失的：进宽限期，把上一轮的模型定义一起存下来，
  //    否则宽限期内没有数据可展示、也写不进 DSH 配置。
  const previousModels = Array.isArray(previous?.models) ? previous.models : []
  const removed = []
  for (const id of lastSet) {
    if (currentIds.has(id) || retired[id] !== undefined) continue
    removed.push(id)
    const model = previousModels.find((item) => item?.id === id)
    if (model === undefined) continue
    retired[id] = { at: now, model }
  }
  // 3) 宽限期里的模型拼回清单，标记 retired，让显示名带上「已下架」。
  const merged = [...models]
  for (const [id, entry] of Object.entries(retired)) {
    const model = entry?.model
    if (model === null || typeof model !== 'object') continue
    merged.push({ ...model, retired: true })
  }
  // 4) 新增的模型：上一轮没见过，也不在宽限期里。
  const added = []
  for (const id of currentIds) {
    if (!lastSet.has(id) && retiredIn[id] === undefined) added.push(id)
  }
  return { models: merged, retired, added, removed, expired }
}

/**
 * 把 `/panel/api/packages` 归一成「哪些积分包快到期了」。
 * @param packages - 面板返回的 packages 响应。
 * @param now - 当前时间戳（毫秒）。
 * @param withinDays - 多少天内到期算「快到期」。
 * @returns `{ accounts, expiringSoon, totalRemain }`。
 */
export function summarizePackages(packages, now, withinDays) {
  const accounts = Array.isArray(packages?.accounts) ? packages.accounts : []
  const horizon = now + Math.max(0, Number(withinDays) || 0) * 86400000
  const expiringSoon = []
  let totalRemain = 0
  for (const account of accounts) {
    const remain = Number(account?.remain) || 0
    totalRemain += remain
    const list = Array.isArray(account?.packages) ? account.packages : []
    for (const pack of list) {
      const end = toEpochMs(pack?.expires_at ?? pack?.end_time)
      if (end === 0 || end > horizon) continue
      const left = Number(pack?.remain) || 0
      if (left <= 0) continue
      expiringSoon.push({
        account: typeof account?.nickname === 'string' && account.nickname !== '' ? account.nickname : String(account?.uid ?? ''),
        realm: typeof account?.realm === 'string' ? account.realm : '',
        name: typeof pack?.name === 'string' ? pack.name : '',
        remain: left,
        endAt: end,
        daysLeft: Math.max(0, Math.ceil((end - now) / 86400000)),
      })
    }
  }
  expiringSoon.sort((a, b) => a.endAt - b.endAt)
  return { accounts: accounts.length, expiringSoon, totalRemain }
}

/**
 * 面板的时间字段可能是毫秒、秒，也可能是 RFC3339 字符串，统一成毫秒。
 * @param value - 原始值。
 * @returns 毫秒时间戳，无法解析返回 0。
 */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return 0
    // 10 位以内当秒，13 位当毫秒。
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return toEpochMs(numeric)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 算出当前该提示哪些告警。
 *
 * 只做「值得打断用户」的那几条：Key 失效、面板长时间不可达、某个域额度见底、
 * 积分包快到期。同一条告警 24 小时内只提示一次（`dismissed` 里记时间戳）。
 * @param input - 见下。
 * @returns 告警数组 `[{ key, level, title, detail }]`。
 */
export function computeAlerts(input) {
  const now = Number(input?.now) || Date.now()
  const dismissed = input?.dismissed !== null && typeof input?.dismissed === 'object' ? input.dismissed : {}
  const thresholds = input?.thresholds ?? {}
  const lowCredits = Number(thresholds.lowCredits) >= 0 ? Number(thresholds.lowCredits) : 50
  const unreachablePolls = Number(thresholds.unreachablePolls) > 0 ? Number(thresholds.unreachablePolls) : 5
  const alerts = []

  const lastError = typeof input?.lastError === 'string' ? input.lastError : ''
  if (lastError.includes('API Key 无效')) {
    alerts.push({ key: 'auth', level: 'error', title: '面板 API Key 失效', detail: lastError })
  }
  if ((Number(input?.consecutiveFailures) || 0) >= unreachablePolls) {
    alerts.push({
      key: 'unreachable',
      level: 'warn',
      title: '面板连续不可达',
      detail: `已连续失败 ${input.consecutiveFailures} 次：${lastError || '连接超时'}`,
    })
  }

  const quota = input?.quota
  const realms = Array.isArray(quota?.realms) ? quota.realms : []
  for (const realm of realms) {
    if (realm.accounts === 0) continue
    const floor = Math.max(lowCredits, (Number(realm.creditsTotal) || 0) * 0.1)
    if ((Number(realm.credits) || 0) > floor) continue
    alerts.push({
      key: `low-credits:${realm.realm}`,
      level: 'warn',
      title: `${realm.label}额度不足`,
      detail: `剩余 ${Math.round(realm.credits)} 积分（阈值 ${Math.round(floor)}）`,
    })
  }

  const expiring = Array.isArray(input?.packages?.expiringSoon) ? input.packages.expiringSoon : []
  if (expiring.length > 0) {
    const head = expiring[0]
    alerts.push({
      key: 'expiry',
      level: 'warn',
      title: '积分包即将到期',
      detail: `${expiring.length} 个包将在 ${head.daysLeft} 天内到期（${head.account} · ${head.name} 剩 ${Math.round(head.remain)}）`,
    })
  }

  const day = 86400000
  return alerts.filter((alert) => {
    const at = Number(dismissed[alert.key]) || 0
    return now - at > day
  })
}
