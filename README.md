# dsh-workbuddy2api-panel

把 [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) 接进 DeepSeek Harness：
自动嗅探面板地址、把面板上的模型同步成 DSH 的模型（带倍率、分国内/国际、可裁剪思考档位），
并在设置页里实时显示剩余额度与模型用量。

不用再手写 `cordis.patch.yml` 里的 `models` 列表了。

| | |
| --- | --- |
| 适用面板 | [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) `1.13.0-panel`（实测通过）；接口见下文「依赖的面板接口」，面板改字段这里要跟着改 |
| 适用 DSH | `@deepseek-ai/dsh-desktop-runtime` `0.2.0-rc.2`（`llm-pi-ai` / `dsh-settings` / `dsh-credentials` 都按这个版本对过） |
| 与本项目的关系 | 这是个**客户端插件**，不修改、不代理面板本身；它只读面板的 HTTP 接口，把结果写进 DSH 自己的 `llm-pi-ai` 配置 |

---

## 和已有 WorkBuddy 插件的区别

DSH 生态里已经有几个接 WorkBuddy 的插件，但**没有一个用面板的管理接口**（对两个主要竞品的宿主源码
`grep -c "panel/api"` 都是 0，它们只读 OpenAI 兼容的 `/v1/models`）：

| 插件 | 做法 | 有 | 没有 |
| --- | --- | --- | --- |
| `wdmb123/dsh-workbuddy2api-panel-bridge` | 薄的 `/v1` 桥，把 `127.0.0.1:7863/v1` 注册成 provider | 模型导入、元数据、思考档位、每模型开关、免重启 | 倍率、分区额度、用量、告警、多地址、子路径 |
| `tearslee/dsh-workbuddy2api` | 托管本地网关进程（自动拉起/回收） | 进程生命周期、模型目录同步、管理命令 | 同上；且假设网关在本机 |
| npm `dsh-workbuddy2api`（FireOpalus） | 自己实现账号池，直接读本机登录 | 多号轮换、熔断、签到 | 不用面板；等于把面板的活重做一遍 |

本插件的差异点全部来自 `/panel/api/*`：**倍率写进模型名**、国内/国际分区额度、
用量与积分统计、告警、下架宽限、面板版本。这些字段 `/v1/models` 里没有。

---

## 它解决什么

原来要在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里手写：

```yaml
- id: llm-pi-ai
  config:
    providers:
      workbuddy2api:
        baseURL: http://192.168.1.10:7863/v1
        apiKeyEnv: WORKBUDDY2API_API_KEY
        models:
          - id: cn:deepseek-v4.1-flash
            name: Deepseek-V4.1-Flash
            contextWindow: 1000000
            maxTokens: 393216
          # ……面板有 50 多个模型，得一个个抄
```

面板一加模型就得重抄一遍，抄漏了还不知道。装上这个插件之后：

1. 装完打开 **设置 → WorkBuddy 面板**，填面板地址（`http://192.168.1.10:7863`），点「保存并同步」；
2. 面板上的模型自动出现在 DSH 的模型选择器里，名字带分区和倍率，例如
   `Deepseek-V4.1-Flash · 国内版 · ×0.11`；
3. 面板加/删模型，插件每 2 分钟自动同步一次，**不需要重启 DSH**；
4. 同一页里能看每个账号剩多少积分、哪些号在冷却、72 小时内的请求数/积分消耗/缓存命中。

---

## 安装

插件是纯 JS（没有构建步骤），可以直接以目录形式装进 profile：

```bash
# 从本仓库目录安装（link 方式，改代码立刻生效）
dsh plugin --profile desktop add "link:/Volumes/SSD/Vibe/dsh/dsh-workbuddy-panel"

# 或者复制到 profile 的 node_modules 下，再手动加进 package.json 的
# dsh.profile.bundles 与 dependencies
```

`dsh plugin add` 会自动把包名写进 profile 的 `dependencies` 和 `dsh.profile.bundles`，
插件自带的 `cordis.patch.yml` 也随之生效（`id: workbuddy-panel`）。

装完**重启一次 DeepSeek Harness**（首次安装要加载宿主侧代码）。
之后改插件配置、改模型选择都不再需要重启。

卸载：

```bash
dsh plugin --profile desktop remove dsh-workbuddy2api-panel
```

---

## 使用

### 1. 连接面板

设置页里的卡片分四块。最上面是连接：

| 字段 | 说明 |
| --- | --- |
| 面板地址 | 每行一个地址，按顺序试连，用第一个通的。填 `192.168.1.10:7863`、`http://…/v1`、`http://…/panel` 都会自动纠正；行尾可加超时秒数（`http://nas:7863 8`）。子路径反代（`https://nas.example.com/wb/`）直接填整条，插件会保留 `/wb` 前缀 |
| 面板 API Key | 存在 DSH 的凭据库里（引用名 `WORKBUDDY2API_API_KEY`），不写进设置文件；留空表示沿用已有的 |
| 自动探测 | 依次试已填地址、当前主机 + 7863、`127.0.0.1:7863`、`localhost:7863`，命中即保存 |
| 测试连接 | 只验证，不保存 |
| 自动同步到 DSH | 关掉之后就只展示、不改 DSH 配置 |

API Key 和 llm-pi-ai 用的是同一个引用名，所以**你原来 `export WORKBUDDY2API_API_KEY=...` 的配置继续有效**，
不需要在插件里再填一遍。面板没开鉴权（`auth_required: false`）时可以留空。

**首次启动会自动接管**：如果插件自己还没存地址，它会先读你 `cordis.patch.yml` 里已有的
`providers.workbuddy2api.baseURL` 和 `apiKeyEnv` 并直接沿用——以前手写过配置的人不用重填。

> ⚠️ **这个 Key 权限很大**：面板的 `/v1/*` 和 `/panel/api/*` 由同一个 Bearer Key 保护
> （`internal/server/handler.go` 的 `withAuth` 用的是 `h.loadLive().APIKey`）。
> 拿到 Key 就等于拿到账号池的管理权限，别外泄，也别贴进 issue。

### 2. 选模型

模型区按「国内版 / 国际版」分组，每行：

- 勾选框：这个模型要不要出现在 DSH 的模型选择器里；
- 模型名 + `id` + 上下文窗口 + 最大输出 + 是否支持图片；
- 倍率标签（`×0.11`）——面板的 `credits` 原文，促销倍率优先；
- 思考档位：面板声明的档位逐个列出，点一下就能关掉某一档。

「全选 / 全不选」在右上角。改完立刻生效（插件会重写 llm-pi-ai 的 `models` 数组，
llm-pi-ai 监听 `loader/volatile-update` 后自行重注册模型）。

> 面板默认有 50 多个模型，插件默认**全部勾选**——不静默丢模型。第一次装完建议先「全不选」，
> 再挑常用的几个勾上，模型选择器会清爽很多。

### 3. 告警与策略

设置页顶部会出现告警条（可逐条关掉，同一条 24 小时内不再弹）：

| 告警 | 触发条件 |
| --- | --- |
| 面板 API Key 失效 | 面板返回 401/403 |
| 面板连续不可达 | 连续失败 5 轮（默认约 10 分钟） |
| 某个域额度不足 | 剩余积分低于 `max(50, 总额 10%)` |
| 积分包即将到期 | 3 天内到期且还有余额 |

底部「策略」卡片：

- **新上架模型**：`自动勾选`（默认）/ `不勾选` / `只提示`。首次导入不受影响（否则选「不勾选」会一个模型都不剩）；
- **额度不足标注**：某个域剩余积分为 0 时，该域模型显示名后加 `· 额度不足`（不影响能不能调用）；
- **清除插件写入的配置**：两次点击确认，用 `unset` 把 `providers.workbuddy2api` 整条移除，并停止自动同步。

面板下架的模型不会立刻消失：先进 24 小时宽限期，期间显示 `· 已下架`，可以点「立即移除」提前删掉。
面板重新上架则自动复活。

### 4. 额度与用量

- **剩余额度**：按国内版/国际版汇总剩余积分、账号数、健康/冷却/停用数量，下面列出前 8 个账号；
- **用量**：请求数、积分消耗、缓存命中率、平均延迟，以及按模型排的用量表（24h / 72h / 168h 可切）。

数据来自面板的 `/panel/api/overview`、`/panel/api/usage?hours=N` 和 `/panel/api/packages`。

### 5. 侧边栏徽标

侧边栏底部、设置按钮旁边有一个小徽标（56px 窄轨下只显示 `WB`），
旁边的小圆点表示状态（绿=正常、黄=有告警、红=最近一次请求失败）。
点一下就地弹出明细（分域剩余/总量、待处理告警数、面板版本）。

**显示什么可以在设置里改**（设置 → WorkBuddy 面板 → 策略 → 侧边栏徽标）：

| 方式 | 宽轨上显示 | 适合 |
| --- | --- | --- |
| 剩余 / 总额 | `WB 1,800 / 3,300` | 想知道「还能用多久」 |
| 分域显示 | `WB 国内 1,500 · 国际 300` | 两个池子的额度分开看 |
| 仅剩余 | `WB 1,800` | 只要一个数，最省地方 |
| 不显示 | 徽标整体隐藏 | 不想占位置（设置页里照样有完整数据） |

默认是「剩余 / 总额」。切换立刻生效，不用重启，也不会重新请求面板。

> 设置页和侧边栏徽标是**两个独立的 React 根**：改完设置，设置页自己会重渲染，但徽标原先只知道自己
> 每 60 秒轮询一次，于是「改了要等一分钟才变」。现在两者通过 bundle 内的一个小发布订阅（`store`）
> 同步：设置页每次拿到新快照就广播，徽标立刻跟着重渲染。

它挂在宿主的 `sidebar.footer.action` 插槽上，读的是插件自己的内存快照（60 秒一次），
**不会额外请求面板**。这个插槽拿不到「打开设置」的句柄，所以明细做成就地浮层，不假装能跳转。

---

## 依赖的面板接口

| 接口 | 用途 |
| --- | --- |
| `GET /panel/api/models` | 模型列表（id 前缀 `cn:` / `global:`、倍率、档位、上下文、促销信息） |
| `GET /panel/api/overview` | 账号池状态（剩余积分、冷却、健康度、面板版本） |
| `GET /panel/api/usage?hours=N` | 用量聚合（totals / by_realm / by_model） |

三个都用 `Authorization: Bearer <api_key>`。面板源码对应
`internal/panel/panel.go`（`handleModels` 的 `panelModelEntry`）、`internal/pool/entry.go`（`Status`）、
`internal/usage/usage.go`（`Snapshot`）。

---

## 设计说明（几个不显然的决定）

**为什么倍率写进模型名？**
DSH 的模型选择器只渲染 `name` 一个字段，没有副标题。想让用户在选择器里就看出价格差异，只能写进名字。

**为什么 `compat.supportsReasoningEffort` 必须显式置 `true`？**
pi-ai 默认按 baseURL 猜这个能力。局域网地址（`192.168.x.x:7863`）会被判成「不支持 reasoning_effort」，
于是思考档位静默失效、所有请求都用面板默认档。面板的 `payload.go` 正是按 `reasoning_effort` 分档的，
所以插件写配置时固定带上 `compat: { supportsReasoningEffort: true, thinkingFormat: 'openai' }`。

**「关闭思考」为什么不是真的关闭？**
面板的 `normalizeReasoningEffort` 会把 `reasoning_effort: "off"` 抬到该模型最低支持的档位；
真正能关掉的路径是发 `thinking: {type: "disabled"}`，但那要求 pi-ai 用 `thinkingFormat: "deepseek"`，
而这个格式会给非 DeepSeek 模型也塞 `thinking` 字段，上游大概率 400。
权衡之后只用 `reasoning_effort`：档位能选，`off` 表现为「该模型最低档」，界面上也照实说明。

**为什么不用宿主的 `configForms` / `SettingsForm`？**
那套是「把插件自己的 Config schema 渲染成表单」。本插件的状态（选中的模型、上次同步时间、面板版本）
不是插件配置，而是运行期数据，塞进 Config schema 会被写进 `cordis.patch.yml` 并触发不必要的重载。
所以插件自己开了一组 HTTP 接口（`/workbuddy-panel/api/*`），前端直接 `fetch`。

**为什么重启后第一次同步会「等一会儿」？**
DSH 启动时，插件的 `webServer` 依赖先就绪、凭据服务（`credentials`）可能后注册。
此时 `ctx.get('credentials')` 还是 `undefined`，请求会光着发出去，被面板 401——
用户看到的就是「面板 API Key 失效」，但刷新一下又好了。
所以取 Key 时最多等 3 秒（凭据服务出现或 resolve 成功即走），碰到 401 再重试一次，
仍然失败才记错误；冷启动 60 秒内失败的话下一轮只等 15 秒，不走指数退避。

**为什么 API Key 不落盘？**
写进 DSH 的凭据库（`ctx.credentials.set`），和 llm-pi-ai 共用 `WORKBUDDY2API_API_KEY` 这个引用名。
状态文件 `workbuddy-panel.json` 里只有地址、选择、时间戳，测试里也断言了 Key 不会出现在快照或状态文件中。

---

## 已知限制

- 宿主的 `/api/*` 有会话鉴权，但 `webServer.register` 注册的插件路由不在那层中间件之后。
  插件接口因此对本机开放（DSH web 默认只监听 `127.0.0.1`）；非本机来源的写接口会被拒绝（403），
  避免把宿主变成 SSRF 跳板。
- 插件只写 llm-pi-ai 的 `providers.workbuddy2api` 这一条路由，不动 `agent-default-model`。
  如果你把默认模型设成了面板上已删除的模型，DSH 那边会报模型不存在——插件不会替你改默认模型。
- 面板的 `promo_factor` / `promo_label` 只做展示，不参与倍率计算（真实倍率以 `promo_credits` 为准）。
- **这条 provider 由插件接管**：`providers.workbuddy2api` 下的 `displayName`/`api`/`baseURL`/
  `apiKeyEnv`/`compat`/`models` 每次同步都会按面板现状重写，手改 YAML 会被下一轮覆盖。
  想手动控制就关掉「自动同步到 DSH」，或者在插件里改勾选/档位。
- 写配置前会做一次规范化比较，内容没变就不写（写一次会让 llm-pi-ai 重新注册全部模型）。
- 连续失败时轮询按 120s → 240s → … → 30 分钟退避，恢复后回到基准间隔。
- 下架宽限期默认 24 小时，期间模型仍在配置里；面板那边如果已经彻底删了，调用会由面板返回错误。
- 改宿主侧代码（`lib/*.js`）需要重启 DSH；改前端（`client/client.js`）刷新页面即可。

---

## 离线验证（不需要真面板）

```bash
node scripts/mock-panel.mjs --port 7863            # 12 个假模型，鉴权开启
node scripts/mock-panel.mjs --port 7863 --models 40 --fail-auth
node scripts/mock-panel.mjs --port 7863 --empty     # 空模型列表，验证「无模型」状态
```

插件里填 `127.0.0.1:7863`、Key 填任意非空值即可。运行中可以直接改假数据来验证边界场景：

```bash
curl -X POST -d '{"id":"cn:kimi-k3-1"}' http://127.0.0.1:7863/mock/models/remove   # 验证下架宽限
curl -X POST -d '{"realm":"global","credits":0}' http://127.0.0.1:7863/mock/credits  # 验证额度不足
curl -X POST -d '{"days":2}' http://127.0.0.1:7863/mock/package-expiry              # 验证到期告警
curl http://127.0.0.1:7863/mock/state                                               # 看当前假数据
```

---

## 开发

```bash
# 全部测试（44 个，无第三方依赖）
node --test
```

- `lib/panel.js` —— 纯函数层（URL 归一、面板条目 → DSH 模型档案、额度/用量/积分包归一、下架对齐、告警计算），测试覆盖最厚；
- `lib/index.js` —— 宿主插件（轮询、写 llm-pi-ai 配置、HTTP 接口）；
- `client/client.js` —— 设置页卡片（ModuleLoader 格式，运行时 `require('react')` 与 ui-primitives）。

`tests/host.test.mjs` 用假 cordis 上下文 + 假面板响应把「配置 → 拉模型 → 写配置 → 前端读快照」跑通，
`tests/client.test.mjs` 用一个极简 React 替身把前端 bundle 跑起来检查渲染，
`tests/e2e-mock.test.mjs` 会真的拉起 `scripts/mock-panel.mjs` 走真实 HTTP 跑一遍全流程。
都不需要真的启动 DSH。

目录：

```
lib/panel.js          纯函数层
lib/index.js          宿主插件入口
client/client.js      设置页前端
tests/                panel / host / client 三组测试
REQUIREMENTS.md       最初的需求文档（含取舍记录）
```
