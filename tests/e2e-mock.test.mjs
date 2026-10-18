/**
 * 端到端测试：真的起一个 HTTP 服务（scripts/mock-panel.mjs）当面板，
 * 让插件走真实的 socket 去连，验证「连接 → 同步 → 下架宽限 → 额度告警」。
 *
 * 和 host.test.mjs 的区别：那边 stub 掉 fetch，只测逻辑；这边测的是
 * 真 HTTP、真 JSON、真状态文件，能抓到「字段名对不上」这类问题。
 *
 * 运行：node --test "tests/*.test.mjs"
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as plugin from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const mockScript = join(here, '..', 'scripts', 'mock-panel.mjs')

/** 找一个空闲端口（用完立刻释放，交给子进程去监听）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 等 mock panel 打印出启动日志（说明已经在监听）。 */
function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock panel 启动超时')), 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (chunk.includes('已启动')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`mock panel 提前退出：${code}`))
    })
  })
}

/** 最小可用的 cordis 上下文（和 host.test.mjs 里那份同构，但只留需要的方法）。 */
function makeContext(dir) {
  const routes = []
  const mutations = []
  const doc = { providers: {}, revision: 3 }
  const settings = {
    documentPath: join(dir, 'cordis.patch.yml'),
    describe: () => [{ ns: 'llm-pi-ai', revision: doc.revision, value: structuredClone(doc), applies: 'live' }],
    mutate: async (ns, ops, revision) => {
      mutations.push({ ns, ops, revision })
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
  const ctx = {
    get: (name) =>
      name === 'settings'
        ? settings
        : name === 'credentials'
          ? { resolve: async () => 'mock-key', set: async () => {} }
          : undefined,
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
  return { ctx, routes, mutations, doc }
}

/** 把插件路由挂到一个真实 http 服务器上。 */
async function serve(handler) {
  const server = createServer((request, response) => handler(request, response))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}/workbuddy-panel/api`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

test('端到端：连假面板、同步模型、下架宽限、额度告警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wbpanel-e2e-'))
  const port = await freePort()
  const panelUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [mockScript, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const { ctx, routes, mutations, doc } = makeContext(dir)
  let server
  try {
    await waitForReady(child)
    plugin.apply(ctx, {})
    await tick()
    server = await serve(routes[0].handler)

    // 1) 连接：真实 HTTP 打到假面板，拉到 12 个模型并写进 llm-pi-ai。
    const first = await (
      await fetch(`${server.base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ panelUrl, refresh: true }),
      })
    ).json()
    assert.equal(first.ok, true, first.error)
    assert.ok(first.models.length >= 12, `应同步到面板全部模型，实际 ${first.models.length}`)
    assert.equal(doc.providers.workbuddy2api.models.length, first.models.filter((row) => row.enabled).length)
    assert.ok(first.panelVersion.startsWith('mock-'), '应读到面板版本')
    assert.ok(first.quota.total.accounts === 3, '应读到 3 个账号')
    assert.ok(first.usage !== null && first.usage.totals.requests > 0, '应读到用量')

    // 2) 下架宽限：面板删掉一个模型，插件仍保留它并标注「已下架」。
    const victim = 'cn:kimi-k3-1'
    await fetch(`${panelUrl}/mock/models/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: victim }) })
    const second = await (await fetch(`${server.base}/refresh`, { method: 'POST' })).json()
    const kept = second.models.find((row) => row.id === victim)
    assert.ok(kept !== undefined, '宽限期内应保留已下架的模型')
    assert.equal(kept.retired, true)
    assert.ok(kept.displayName.includes('已下架'))
    assert.equal(second.retired.length, 1)

    // 3) 额度归零：国际版模型标注「额度不足」并产生告警。
    await fetch(`${panelUrl}/mock/credits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ realm: 'global', credits: 0 }) })
    const third = await (await fetch(`${server.base}/refresh`, { method: 'POST' })).json()
    const globalModel = third.models.find((row) => row.id.startsWith('global:'))
    assert.ok(globalModel.displayName.includes('额度不足'), '国际版额度为 0 应标注')
    assert.ok(third.alerts.some((alert) => alert.key === 'low-credits:global'), '应产生额度告警')

    // 4) 清除：整条路由 unset 掉，并停止同步。
    const cleared = await (
      await fetch(`${server.base}/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
    ).json()
    assert.equal(cleared.sync, false)
    assert.equal(doc.providers.workbuddy2api, undefined)
    const last = mutations[mutations.length - 1]
    assert.deepEqual(last.ops, [{ op: 'unset', path: ['providers', 'workbuddy2api'] }])
  } finally {
    if (server !== undefined) await server.close()
    child.kill('SIGTERM')
    await rm(dir, { recursive: true, force: true })
  }
})
