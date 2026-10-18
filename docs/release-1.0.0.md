# dsh-workbuddy2api-panel 1.0.0

首个稳定版。把 [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) 接进
DeepSeek Harness：自动嗅探面板、把模型（带倍率、分国内/国际、可裁剪思考档位）同步成 DSH 的模型，
并在设置页实时显示额度与用量、在侧边栏常驻一枚额度徽标。

## 这个版本有什么

**与 0.5.1 没有行为差异**：功能面到这里定型，之后按语义化版本发版。

从 0.5.x 升上来不需要改任何配置：状态文件、`cordis.patch.yml`、provider 键、面板地址都沿用。

## 主要能力

- **自动嗅探**：候选地址按顺序试连，支持多地址与反向代理子路径（`https://nas.example.com/wb/`），
  每个地址可单独设超时；连上后记住可用的那个。
- **模型同步**：面板 `/panel/api/models` → `llm-pi-ai` 的 `providers.workbuddy2api`，每 2 分钟一轮，
  差异写入（内容没变不碰配置），始终不重启 DSH。
- **倍率**：写进模型显示名（DSH 选择器只渲染 `name`），促销期用 `promo_credits`，`×0` 会显示出来。
- **国内 / 国际**：按 `cn:` / `global:` 分区，分区汇总剩余积分与账号健康度。
- **思考档位**：面板声明的档位逐个列出，可裁掉不想要的；`can_disable_thinking` 的模型才给「关闭」。
- **额度与用量**：24h / 72h / 168h 的请求数、积分消耗、缓存命中、按模型排行。
- **告警**：Key 失效、连续不可达、分区额度见底、积分包快到期，24 小时内只提示一次。
- **下架宽限**：面板删掉的模型保留 24 小时（标「已下架」），可立即移除。
- **侧边栏徽标**：剩余/总额、分域、仅剩余、不显示，四种显示方式即改即生效。
- **安全**：写接口要求「本机回环 + 同源 + `application/json`」；API Key 只进凭据库，不落盘。

## 安装 / 升级

```bash
dsh plugin --profile desktop add link:/path/to/dsh-workbuddy2api-panel
```

装完重启 DSH，打开 **设置 → WorkBuddy 面板**，填面板地址（如 `http://192.168.1.10:7863`），
「保存并同步」。Key 会自动写进 DSH 凭据库的 `WORKBUDDY2API_API_KEY`。

## 验证

- 66 个测试全绿（`node --test`），Node 20 / 22 / 24 都跑过；
- 行覆盖率 93.9%，分支 79.3%；
- 安全相关的三个分支（非本机、跨站、非 JSON）与 4 条 P0 回归都有专门用例，
  并且验证过「修复前的代码上会失败」。

## 已知限制

- 插件路由在宿主鉴权之后**没有**额外中间件，所以写接口靠三道闸兜底；如果 DSH 自己被暴露到局域网
  （绑定 `0.0.0.0` 或同机反代），外部请求的 `remoteAddress` 也落在回环上，写接口会被放行——
  这种部署请在反向代理层加认证。
- 用量是**整个账号池**的口径（面板统计所有客户端），不是本 DSH 单独的消耗。
- 插件只写 `providers.workbuddy2api` 这一条路由，不改 `agent-default-model`。

完整说明见 [README](https://github.com/jerry9692/dsh-workbuddy2api-panel#readme)，
逐版本变化见 [CHANGELOG](https://github.com/jerry9692/dsh-workbuddy2api-panel/blob/main/CHANGELOG.md)。
