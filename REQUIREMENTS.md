# dsh-workbuddy2api-panel 需求文档（待评审）

> 状态：**草稿，未实现**。评审通过后才动工。

## 1. 背景与痛点

你在 NAS（Docker）上部署了 [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)，把腾讯 WorkBuddy/CodeBuddy 账号池反代成 OpenAI 兼容 API（默认端口 7863，OpenAI 端点 `/v1`，管理面板 `/panel`）。

目前接入 DSH 的方式是**手写** `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai` 的 provider 配置（你现在的配置就是这么写的，baseURL 指向 `http://192.168.1.10:7863/v1`）。痛点：

- 每新增/下线一个模型都要手改 YAML，模型 ID、contextWindow、maxTokens 全靠手抄；
- 看不到每个模型的**倍率**（积分牌价），选模型时不知道哪个贵；
- 国内版（`cn:` 前缀）和国际版（`global:` 前缀）混在一起，不好区分；
- 模型的**思考档位**（low/medium/high 等）没有同步进来，无法在 DSH 里切换；
- 剩余额度、各账号用量要去 NAS 的面板网页看，DSH 里完全没有。

## 2. 目标

做一个 DSH 插件 `dsh-workbuddy2api-panel`，把上面这些全部自动化。

## 3. 功能需求

### F1 面板连接与嗅探

- 设置页里可以**手动填写**面板地址和 API Key（panel 的所有 API 都用 `Authorization: Bearer <api_key>` 鉴权，即配置里的 `api_key` 字段）。
- 同时提供**自动嗅探**：对一组候选地址逐个试连 `GET /panel/api/models`（候选 = 用户已填的地址、当前页面主机名 + `:7863`、`http://127.0.0.1:7863`、`http://localhost:7863`；不内置任何个人地址），连上就提示"发现面板，一键导入"。
- 连接成功后，API Key 存入 DSH 的 credentials 服务（环境变量名 `WORKBUDDY2API_API_KEY`），并自动把 `llm-pi-ai` 的 provider 路由（`workbuddy2api`）的 `baseURL`/`apiKeyEnv` 配好。

### F2 模型同步（核心）

定时（默认 120 秒，可调 30–3600 秒）从 `GET /panel/api/models` 拉取模型清单，同步成 `llm-pi-ai` 配置里的 `providers.workbuddy2api.models`：

- **模型选择**：插件面板里每个模型一个勾选项，只有勾选的模型才会出现在 DSH 模型列表里。勾选状态持久化（存插件自己的配置）。
- **国内/国际区分**：模型 ID 自带 `cn:` / `global:` 前缀，显示名加 `[国内]` / `[国际]` 标签，面板里按区分组显示。
- **倍率显示**：每个模型后面显示 `×N` 倍率（panel 的 `credits` 字段；有限时折扣时显示 `promo_label` 和折扣价）。该信息同时体现在 DSH 模型选择器能看到的模型显示名里（例如 `Kimi-K3 [国内] ×1`）。
- **思考档位**：panel 的 `supported_efforts` 映射为 `llm-pi-ai` 模型配置里的 `reasoningEfforts` 字典（`low/medium/high/xhigh/max` 及其 wire 值），`can_disable_thinking` 映射为允许 `off` 档。插件面板里逐个模型提供「哪些档位可用」的勾选，实际切换由 DSH 聊天界面的档位选择器完成。
  - 已查证：`llm-pi-ai` 的 `PiAiModelProfile` 没有 per-model 默认档字段（只有路由级 `reasoning`），所以**不做**「每模型默认档」。
  - `off` 的真实语义：面板的 `normalizeReasoningEffort` 会把 `reasoning_effort:"off"` 抬到该模型最低支持档；真正关闭需要 `thinkingFormat:"deepseek"` 发 `thinking:{type:"disabled"}`，但那会给非 DeepSeek 模型也塞 `thinking` 字段（上游可能 400）。故只用 `reasoning_effort`，界面上照实说明。
- **能力字段自动填充**：`context_length` → `contextWindow`，`max_output_tokens` → `maxTokens`，`supports_images` → `input: [text, image]`（否则 `[text]`）。不再手抄。
- **准实时更新（轮询，非推送）**：`llm-pi-ai` 的配置是 Volatile 的，插件通过 settings 服务（`settings.mutate('llm-pi-ai', ...)`）写入后，DSH 运行时立即重新注册模型路由，**无需重启**。panel 端模型上下架/倍率变化后，默认 120 秒内 DSH 跟上；插件面板也有"立即刷新"按钮。面板没有 SSE/WebSocket，所以是准实时，不是实时。
- **差异写入**：写入前把目标配置与现值做规范化比较（键序无关），完全一致就跳过——否则每轮都会让 `llm-pi-ai` 重新注册全部模型。
- **revision 冲突**：`settings.mutate` 带 `expectedRevision`，冲突时重读一次再重试，不直接覆盖也不报错给用户。
- **首次接管**：启动时若插件自己没存地址，先读现有 `providers.workbuddy2api.baseURL` / `apiKeyEnv` 并接管，用户不用重填。

### F3 额度与用量展示

插件设置页卡片里显示（前端 15 秒轮询内存快照 `/state`，面板请求只有后台一轮，默认 120 秒；连续失败时指数退避，上限 30 分钟）：

- **剩余额度总览**：所有账号剩余积分合计、国内/国际分开合计（来自 `GET /panel/api/overview` 的账号池 `credits`/`credits_total`/`realm`）。
- **账号列表**：每个账号的昵称、域（国内/国际）、剩余/总额度、健康状态（健康/冷却/禁用）。
- **用量统计**：最近 24h / 72h / 168h（可切）的请求数、消耗积分，按模型/按账号的分布（来自 `GET /panel/api/usage?hours=N`），含简单的时间序列。
  - **口径说明**：面板统计的是**整个账号池**，包含 NAS 上其它客户端的消耗，不是 DSH 自己用了多少——界面上必须写明。
- **积分包明细**：每个账号的积分包剩余和到期情况（来自 `GET /panel/api/packages`）。
- **状态栏摘要**（如果 DSH 客户端槽位支持）：状态栏显示"WB 剩余 ××× 积分"，点击展开详情；不支持则降级为仅设置页卡片。

### F4 失效与容错

- panel 连不上时：不清空已同步的模型（避免正在进行的会话断掉），设置页显示"连接失败，展示的是上次同步结果（时间戳）"。
- API Key 失效（401）：明确提示重新填写。
- 嗅探只在用户点击"嗅探"或插件首次安装时进行，不持续扫网段。

## 4. 技术方案（已取证，非猜测）

### DSH 侧机制（源码已验证）

- 插件体系：cordis，插件包带 `dsh.bundle.patch: ./cordis.patch.yml`（内容为一行 insert 条目）即可被 `dsh plugin add` 或插件市场安装。
- 模型层：`@deepseek-ai/dsh-llm-pi-ai`（你已装）。其 `Config.providers` 是 cordis `Volatile`，插件挂载时监听 `loader/volatile-update`，**配置一变就重新注册全部模型路由**。模型条目支持 `id/name/contextWindow/maxTokens/input/reasoningEfforts` 字段——正好装下 panel 给的全部信息。
- 写配置：`ctx.settings.mutate(ns, ops, expectedRevision)`（`@deepseek-ai/dsh-settings` 0.2.x），ns 为 `llm-pi-ai`，路径如 `["providers","workbuddy2api","models"]`。
- 存密钥：`ctx.credentials.set(ref, value)`（`@deepseek-ai/dsh-credentials`），ref 即 `WORKBUDDY2API_API_KEY`。
- UI：客户端 bundle（`dsh.client`，React）通过 `ctx.slots.register({ name: "settings.section", ... })` 在设置页注册一个区块（dshmarket 插件同款做法）；前端通过 `fetch('/<插件路由前缀>/...')` 调自己插件在 webServer 服务上注册的 HTTP 路由拿数据。
- 后端路由：`ctx.webServer.register({ kind: 'prefix', path: '/workbuddy-panel/api', handler })`（dshmarket 同款）。

### panel 侧 API（源码已验证，均 `Bearer api_key` 鉴权）

| 端点 | 用途 |
|---|---|
| `GET /panel/api/models` | 模型列表：`id`（`cn:`/`global:` 前缀）、`name`、`credits`（倍率）、`promo_*`、`supported_efforts`、`default_effort`、`can_disable_thinking`、`supports_images`、`context_length`、`max_output_tokens` |
| `GET /panel/api/overview` | 账号池：每账号 `credits`（剩余）、`credits_total`、`realm`、`disabled`/`cooling` 状态 |
| `GET /panel/api/usage?hours=72` | 用量快照：totals、by_realm、by_account、by_model、series |
| `GET /panel/api/packages` | 每账号积分包剩余/到期 |

### 参考的已有项目

- **dshmarket**（你已装的插件市场）：插件骨架、设置页区块注册、后端路由注册的范本。
- `llm-pi-ai` 自带的 `discoverModels`：只拉 `/v1/models`，拿不到倍率/思考档位/额度，不满足需求，故不自用但参考其接入方式。
- 未发现其他对接 workbuddy2api 的 DSH 插件（panel 项目本身较新，上游 Sliverkiss/workbuddy2api 已删库）。

## 5. 交付物与目录

```
dsh-workbuddy2api-panel/
├── package.json          # 含 dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 一行 insert
├── src/index.ts          # cordis 入口：Config schema、嗅探、模型同步循环、路由
├── client/index.tsx      # 设置页区块：连接配置、模型勾选、额度用量面板
└── REQUIREMENTS.md       # 本文档
```

安装方式：`dsh plugin --profile desktop add /path/to/dsh-workbuddy2api-panel`（或打包后经 dshmarket 安装）。

## 6. 明确的非目标

- 不做账号管理（添加/删除 WorkBuddy 账号仍用 panel 自己的网页）。
- 不替代 `llm-pi-ai`，只做它的配置生成器。
- 不碰 panel 的任务中心/签到等自动化功能。

## 7. 待你确认的开放问题

1. **同步冲突**：如果你之后还想手改 `cordis.patch.yml` 里的 `workbuddy2api` provider，插件的定时同步会覆盖你的手改。要不要加"同步开关"（关掉后插件只读不写）？（建议：有，默认开）
2. **倍率展示位置**：写进模型显示名（`Kimi-K3 [国内] ×1`）会出现在 DSH 所有模型选择器里；只在插件面板里显示则更干净但选择模型时看不到。（建议：写进显示名）
3. **状态栏**：是否接受"如果客户端槽位不支持状态栏就只做设置页"的降级？
4. 插件名字 `dsh-workbuddy2api-panel` 可以吗？想不想顺便发布到插件市场（awesome-dsh-plugin.com）？
