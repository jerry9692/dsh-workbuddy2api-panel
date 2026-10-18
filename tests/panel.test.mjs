/**
 * lib/panel.js 的单元测试（node:test，无第三方依赖）。
 *
 * 运行：node --test tests/
 * 夹具按面板源码的真实响应手写：internal/panel/panel.go 的 handleModels、
 * internal/pool/entry.go 的 Status、internal/usage/usage.go 的 Snapshot。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRouteModels,
  canonicalJson,
  formatAddressLines,
  parseAddressLines,
  clampEfforts,
  modelDisplayName,
  modelRate,
  modelReasoningEfforts,
  normalizeBaseUrl,
  pollIntervalMs,
  probeCandidates,
  realmLabel,
  realmOf,
  routeConfigMatches,
  summarizeOverview,
  summarizeUsage,
  toModelRow,
  toModelProfile,
} from '../lib/panel.js'

test('normalizeBaseUrl 纠正用户抄来的各种地址形态', () => {
  assert.equal(normalizeBaseUrl('192.168.1.10:7863'), 'http://192.168.1.10:7863')
  assert.equal(normalizeBaseUrl('http://192.168.1.10:7863/'), 'http://192.168.1.10:7863')
  assert.equal(normalizeBaseUrl('http://192.168.1.10:7863/v1'), 'http://192.168.1.10:7863')
  assert.equal(normalizeBaseUrl('http://192.168.1.10:7863/v1/'), 'http://192.168.1.10:7863')
  assert.equal(normalizeBaseUrl('http://192.168.1.10:7863/panel'), 'http://192.168.1.10:7863')
  assert.equal(normalizeBaseUrl('https://nas.example.com/wb/panel/'), 'https://nas.example.com/wb')
  assert.equal(normalizeBaseUrl('  http://host:7863//  '), 'http://host:7863')
  assert.equal(normalizeBaseUrl('ftp://host'), '')
  assert.equal(normalizeBaseUrl(''), '')
  assert.equal(normalizeBaseUrl(null), '')
})

test('realmOf / realmLabel 区分国内与国际账号', () => {
  assert.equal(realmOf('cn:deepseek-v4.1-flash'), 'cn')
  assert.equal(realmOf('global:gpt-6-astra'), 'global')
  assert.equal(realmOf('cn:'), 'cn')
  assert.equal(realmOf('weird:model'), '')
  assert.equal(realmOf('nocolon'), '')
  assert.equal(realmOf(undefined), '')
  assert.equal(realmLabel('cn'), '国内版')
  assert.equal(realmLabel('global'), '国际版')
  assert.equal(realmLabel(''), '未知')
})

test('modelRate 取面板倍率原文，促销倍率优先', () => {
  assert.equal(modelRate({ credits: 'x0.05' }), '0.05')
  assert.equal(modelRate({ credits: '0.05x' }), '0.05')
  assert.equal(modelRate({ credits: 'x1' }), '1')
  assert.equal(modelRate({ credits: 'x2', promo_credits: 'x0.5' }), '0.5')
  assert.equal(modelRate({ credits: '-' }), '-')
  assert.equal(modelRate({}), '')
  assert.equal(modelRate(null), '')
})

test('modelDisplayName 把倍率与分区写进选择器可见的名字', () => {
  assert.equal(
    modelDisplayName({ id: 'cn:kimi-k3-1', name: 'Kimi-K3 1.6T', credits: 'x0.05' }),
    'Kimi-K3 1.6T · 国内版 · ×0.05',
  )
  assert.equal(modelDisplayName({ id: 'global:gpt-6-astra', name: 'GPT-6 Astra' }), 'GPT-6 Astra · 国际版')
  assert.equal(modelDisplayName({ id: 'cn:x' }), 'cn:x · 国内版')
})

test('modelReasoningEfforts 只声明面板支持的档位', () => {
  assert.deepEqual(modelReasoningEfforts({ supported_efforts: ['low', 'high', 'max'], can_disable_thinking: false }), {
    low: 'low',
    high: 'high',
    max: 'max',
  })
  // off 排在最前，且发的是字符串而不是 null（null 会被面板补成「开启思考」）。
  assert.deepEqual(modelReasoningEfforts({ supported_efforts: ['high'], can_disable_thinking: true }), {
    off: 'off',
    high: 'high',
  })
  // 非推理模型 → false（DSH 不显示档位）。
  assert.equal(modelReasoningEfforts({ supported_efforts: [], supports_reasoning: false }), false)
  // 声明了推理但没给档位 → undefined（交给 DSH 默认行为）。
  assert.equal(modelReasoningEfforts({ supported_efforts: [], supports_reasoning: true }), undefined)
  // 只有 off 没有正档 → 退回 false，否则 DSH 会拒绝整份档案。
  assert.equal(modelReasoningEfforts({ supported_efforts: [], can_disable_thinking: true }), false)
  // 未知档位被丢掉，重复档位去重。
  assert.deepEqual(modelReasoningEfforts({ supported_efforts: ['LOW', 'low', 'turbo', 'medium'] }), {
    low: 'low',
    medium: 'medium',
  })
})

test('clampEfforts 按用户选择裁剪档位', () => {
  const efforts = { off: 'off', low: 'low', high: 'high' }
  assert.deepEqual(clampEfforts(efforts, ['high']), { off: 'off', high: 'high' })
  // 空选择 = 全选。
  assert.deepEqual(clampEfforts(efforts, []), efforts)
  // 裁剪后没有正档 → 保留原值，避免校验失败。
  assert.deepEqual(clampEfforts(efforts, ['medium']), efforts)
  assert.equal(clampEfforts(false, ['high']), false)
})

test('toModelProfile 只写 DSH 认识的字段', () => {
  const profile = toModelProfile({
    id: 'cn:deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    credits: 'x0.05',
    context_length: 1000000,
    max_output_tokens: 64000,
    supports_images: true,
    supported_efforts: ['low', 'high', 'max'],
    can_disable_thinking: false,
    description: '不该出现在档案里',
    tags: ['fast'],
  })
  assert.deepEqual(profile, {
    id: 'cn:deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash · 国内版 · ×0.05',
    contextWindow: 1000000,
    maxTokens: 64000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  })
  assert.equal(toModelProfile({}), undefined)
  assert.equal(toModelProfile(null), undefined)
  assert.equal(toModelProfile({ id: '  ' }), undefined)
  // 没有 max_output_tokens / supports_images 时不写这两个键。
  const bare = toModelProfile({ id: 'global:gpt-6-astra', name: 'GPT-6 Astra', context_length: 400000, supported_efforts: [] })
  assert.deepEqual(bare, { id: 'global:gpt-6-astra', name: 'GPT-6 Astra · 国际版', contextWindow: 400000, reasoningEfforts: false })
})

test('buildRouteModels 国内在前、国际在后，并尊重用户选择', () => {
  const models = [
    { id: 'global:gpt-6-astra', name: 'GPT-6 Astra', supported_efforts: [] },
    { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', supported_efforts: ['high'] },
    { id: 'cn:glm-5.3', name: 'GLM-5.3', supported_efforts: ['low', 'high'] },
    { id: 'global:grok-4.7', name: 'Grok 4.7', supported_efforts: ['high'] },
  ]
  const ids = buildRouteModels(models, {}).map((model) => model.id)
  assert.deepEqual(ids, ['cn:deepseek-v4.1-flash', 'cn:glm-5.3', 'global:gpt-6-astra', 'global:grok-4.7'])

  const picked = buildRouteModels(models, {
    'cn:glm-5.3': { enabled: false },
    'cn:deepseek-v4.1-flash': { efforts: ['high'] },
    'global:grok-4.7': { enabled: true },
  })
  assert.deepEqual(
    picked.map((model) => model.id),
    ['cn:deepseek-v4.1-flash', 'global:gpt-6-astra', 'global:grok-4.7'],
  )
  // 未知域（未来可能新增）也不能被静默丢掉。
  const third = buildRouteModels([{ id: 'x:model', name: 'X', supported_efforts: [] }], {})
  assert.deepEqual(third.map((model) => model.id), ['x:model'])
})

test('toModelRow 给前端足够信息', () => {
  const row = toModelRow(
    {
      id: 'cn:kimi-k3-1',
      name: 'Kimi-K3 1.6T',
      credits: 'x0.05',
      promo_label: '限时',
      promo_factor: '0.8',
      context_length: 256000,
      max_output_tokens: 32000,
      vendor: 'moonshot',
      tags: ['fast', 3],
      supports_images: true,
      supports_tool_call: true,
      supported_efforts: ['low', 'high'],
      can_disable_thinking: true,
      default_effort: 'high',
      description: 'desc',
    },
    { 'cn:kimi-k3-1': { enabled: false, efforts: ['high'] } },
  )
  assert.equal(row.realm, 'cn')
  assert.equal(row.realmLabel, '国内版')
  assert.equal(row.rate, '0.05')
  assert.equal(row.promoLabel, '限时')
  assert.deepEqual(row.efforts, ['low', 'high'])
  assert.equal(row.canDisableThinking, true)
  assert.equal(row.defaultEffort, 'high')
  assert.equal(row.enabled, false)
  assert.deepEqual(row.selectedEfforts, ['high'])
  assert.deepEqual(row.tags, ['fast'])
  assert.equal(row.contextWindow, 256000)
  // 没有用户选择时默认显示。
  assert.equal(toModelRow({ id: 'cn:a', name: 'A', supported_efforts: [] }, {}).enabled, true)
})

test('summarizeOverview 按域汇总剩余积分与健康度', () => {
  const summary = summarizeOverview({
    version: '1.7.2',
    uptime_sec: 3600,
    auth_required: true,
    redis_mode: true,
    accounts: [
      { uid: 'a', realm: 'cn', credits: 1000, credits_total: 2000 },
      { uid: 'b', realm: 'cn', credits: 500, credits_total: 1000, cooling: true },
      { uid: 'c', realm: 'global', credits: 300, credits_total: 300 },
      { uid: 'd', realm: 'global', credits: 0, credits_total: 100, disabled: true },
      { uid: 'e', credits: 42, credits_total: 42 },
    ],
  })
  const cn = summary.realms.find((realm) => realm.realm === 'cn')
  const global = summary.realms.find((realm) => realm.realm === 'global')
  assert.equal(cn.accounts, 2)
  assert.equal(cn.healthy, 1)
  assert.equal(cn.cooling, 1)
  assert.equal(cn.credits, 1500)
  assert.equal(global.accounts, 2)
  assert.equal(global.healthy, 1)
  assert.equal(global.disabled, 1)
  assert.equal(global.credits, 300)
  assert.equal(summary.total.accounts, 5)
  assert.equal(summary.total.credits, 1842)
  // 缺 realm 的账号不猜成国内版，单独归到「未知」。
  const unknown = summary.realms.find((realm) => realm.realm === 'unknown')
  assert.equal(unknown.accounts, 1)
  assert.equal(unknown.label, '未知')
  assert.equal(summary.version, '1.7.2')
  assert.equal(summary.authRequired, true)
  // 空概览不能炸。
  assert.equal(summarizeOverview(undefined).total.accounts, 0)
})

test('summarizeUsage 取用量并按积分排序', () => {
  const usage = summarizeUsage({
    totals: {
      requests: 120,
      errors: 2,
      total_tokens: 3_000_000,
      credits: 45.5,
      cache_hit_rate: 0.42,
      avg_latency_ms: 1830,
    },
    by_realm: [
      { key: 'cn', requests: 80, total_tokens: 2_000_000, credits: 20 },
      { key: 'global', requests: 40, total_tokens: 1_000_000, credits: 25.5 },
    ],
    by_model: [
      { key: 'cn:kimi-k3-1', realm: 'cn', requests: 10, total_tokens: 1000, credits: 1 },
      { key: 'global:gpt-6-astra', realm: 'global', requests: 5, total_tokens: 2000, credits: 9 },
      { key: 'cn:unused', realm: 'cn', requests: 0, total_tokens: 0, credits: 0 },
    ],
    window_from: '2024-05-01T00:00:00Z',
    window_to: '2024-05-04T00:00:00Z',
    generated: '2024-05-04T00:00:01Z',
  })
  assert.equal(usage.totals.requests, 120)
  assert.equal(usage.totals.credits, 45.5)
  assert.equal(usage.byModel.length, 2)
  assert.deepEqual(usage.byModel.map((row) => row.key), ['global:gpt-6-astra', 'cn:kimi-k3-1'])
  assert.equal(usage.realms[0].label, '国内版')
  assert.equal(usage.windowFrom, '2024-05-01T00:00:00Z')
  assert.deepEqual(summarizeUsage(undefined).byModel, [])
})

test('probeCandidates 去重并把用户地址排最前', () => {
  const list = probeCandidates(['192.168.1.10:7863', 'http://192.168.1.10:7863/v1'], '192.168.1.10')
  assert.equal(list[0], 'http://192.168.1.10:7863')
  assert.equal(list.filter((url) => url === 'http://192.168.1.10:7863').length, 1)
  assert.ok(list.includes('http://127.0.0.1:7863'))
  assert.ok(list.includes('http://localhost:7863'))
  assert.deepEqual(probeCandidates(undefined, ''), ['http://127.0.0.1:7863', 'http://localhost:7863'])
})

test('canonicalJson 忽略键序，用来判断配置是否真的变了', () => {
  assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }))
  assert.equal(canonicalJson([{ x: 1, y: 2 }]), canonicalJson([{ y: 2, x: 1 }]))
  assert.equal(canonicalJson(null), 'null')
})

test('routeConfigMatches 只在字段完全一致时返回 true', () => {
  const target = { baseURL: 'http://p:7863/v1', models: [{ id: 'a', name: 'A' }] }
  assert.equal(routeConfigMatches({ baseURL: 'http://p:7863/v1', models: [{ id: 'a', name: 'A' }], extra: 1 }, target), true)
  assert.equal(routeConfigMatches({ baseURL: 'http://p:7863/v1', models: [{ id: 'a', name: 'B' }] }, target), false)
  assert.equal(routeConfigMatches(undefined, target), false)
  assert.equal(routeConfigMatches(null, target), false)
})

test('pollIntervalMs 失败时指数退避，上限 30 分钟', () => {
  assert.equal(pollIntervalMs(120, 0), 120_000)
  assert.equal(pollIntervalMs(120, 1), 240_000)
  assert.equal(pollIntervalMs(120, 3), 960_000)
  assert.equal(pollIntervalMs(120, 99), 30 * 60 * 1000, '再失败也不超过 30 分钟')
  assert.equal(pollIntervalMs(10, 0), 30_000, '基准间隔下限 30 秒')
  assert.equal(pollIntervalMs(undefined, 0), 120_000)
})

test('parseAddressLines：每行一个地址，可选超时秒数', () => {
  const entries = parseAddressLines(`
    # 注释行
    http://192.168.1.10:7863
    https://nas.example.com/wb/  8
    http://192.168.1.10:7863
    nas.local:7863 2
  `)
  assert.deepEqual(entries, [
    { url: 'http://192.168.1.10:7863', timeoutMs: 0 },
    { url: 'https://nas.example.com/wb', timeoutMs: 8000 },
    { url: 'http://nas.local:7863', timeoutMs: 2000 },
  ])
  assert.deepEqual(parseAddressLines(''), [])
  assert.deepEqual(parseAddressLines(null), [])
})

test('parseAddressLines：超时秒数超出范围时夹住', () => {
  assert.equal(parseAddressLines('http://a:7863 999')[0].timeoutMs, 120000)
  assert.equal(parseAddressLines('http://a:7863 -1')[0].timeoutMs, 0)
  assert.equal(parseAddressLines('http://a:7863 abc')[0].timeoutMs, 0)
})

test('formatAddressLines：拼回 textarea 文本', () => {
  assert.equal(formatAddressLines([{ url: 'http://a:7863', timeoutMs: 0 }, { url: 'https://b/wb', timeoutMs: 8000 }]), 'http://a:7863\nhttps://b/wb 8')
  assert.equal(formatAddressLines([]), '')
  assert.equal(formatAddressLines(null), '')
})
