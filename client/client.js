window.__ModuleLoader__.load({
	id: 'dsh-workbuddy2api-panel',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement

		/**
		 * 进程内的快照广播。
		 *
		 * 设置页和侧边栏徽标是两个独立的 React 根：设置页改完策略自己会重渲染，
		 * 但徽标只知道自己每 60 秒轮询一次，于是「改了显示方式要等一分钟才变」。
		 * 两个组件在同一个 bundle 实例里，用一个小的发布订阅把它们连起来。
		 */
		const store = (() => {
			let current = null
			const listeners = new Set()
			return {
				get: () => current,
				set(next) {
					if (next === null || typeof next !== 'object') return
					current = next
					for (const listener of [...listeners]) {
						try {
							listener(next)
						} catch (error) {
							console.error('[dsh-workbuddy2api-panel] 快照订阅者报错', error)
						}
					}
				},
				subscribe(listener) {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
			}
		})()
		// 组件库取不到也不能把宿主带崩：拿不到就用原生元素兜底。
		const primitives = (() => {
			try {
				return require('@deepseek-ai/dsh-client-ui-primitives')
			} catch (error) {
				console.error('[dsh-workbuddy2api-panel] 取不到 UI 组件库，改用原生元素', error)
				return {}
			}
		})()

		const Button =
			primitives.Button ??
			((props) =>
				h(
					'button',
					{
						type: 'button',
						disabled: props.disabled,
						onClick: props.onClick,
						// 降级版也要透传 style/aria-label：清除按钮的红色警示、模型勾选
						// 的可访问名都靠它们，丢了是「看起来正常但少了防护」。
						style: props.style,
						title: props.title,
						'aria-label': props['aria-label'],
					},
					props.children,
				))
		const Checkbox =
			primitives.Checkbox ??
			((props) =>
				h(
					'label',
					{ title: props.title, style: props.style },
					h('input', {
						type: 'checkbox',
						checked: Boolean(props.checked),
						disabled: props.disabled,
						'aria-label': props['aria-label'],
						onChange: () => props.onChange?.(!props.checked),
					}),
					props.label ?? props.children,
				))
		const Switch =
			primitives.Switch ??
			((props) =>
				h(
					'label',
					{ title: props.title },
					h('input', {
						type: 'checkbox',
						checked: Boolean(props.checked),
						disabled: props.disabled,
						onChange: () => props.onChange?.(!props.checked),
					}),
					props.label,
				))

		/** 本插件的语言包命名空间。 */
		const NS = 'workbuddyPanel'

		const zh = {
			nav: 'WorkBuddy 面板',
			title: 'WorkBuddy 面板',
			subtitle: '把 workbuddy2api-panel 的模型接进 DSH，并显示额度与用量。',
			connected: '已连接',
			disconnected: '未连接',
			connecting: '连接中…',
			panelUrl: '面板地址',
			panelUrlHint: '例如 http://192.168.1.10:7863（填 /v1 或 /panel 也能自动纠正）',
			apiKey: '面板 API Key',
			apiKeyHint: '保存在凭据库中，不写入设置文件。留空表示沿用已有的 Key。',
			apiKeySet: '已配置 Key',
			apiKeyUnset: '未配置 Key（面板未开鉴权时可留空）',
			probe: '自动探测',
			probing: '探测中…',
			test: '测试连接',
			save: '保存并同步',
			saving: '保存中…',
			refresh: '刷新',
			refreshing: '刷新中…',
			syncOn: '自动同步到 DSH',
			syncHint: '面板模型变化时自动更新 DSH 的模型列表',
			quota: '剩余额度',
			cn: '国内版',
			global: '国际版',
			accounts: '账号',
			healthy: '健康',
			cooling: '冷却',
			disabled: '停用',
			credits: '积分',
			usage: '用量',
			poolNote: '用量与积分是面板账号池的总量，包含 NAS 上其它客户端的消耗。',
			footerLabel: 'WorkBuddy 额度',
			footerHint: '详情见 设置 → WorkBuddy 面板',
			alertsCount: '条提醒待处理',
			addressesHint: '每行一个地址，按顺序尝试；地址后可加超时秒数（如 http://nas:7863 8）',
			activeAddress: '当前使用',
			retired: '已下架',
			removeNow: '立即移除',
			newModels: '面板新增模型',
			newModelsHint: '这些模型刚出现在面板上，还没进 DSH 选择器。',
			enableAllNew: '全部启用',
			policyTitle: '策略',
			newModelPolicy: '新上架模型',
			policySelect: '自动勾选',
			policyIgnore: '不勾选',
			policyNotify: '只提示',
			lowCreditMark: '额度不足标注',
			footerSection: '侧边栏徽标',
			footerRatio: '剩余 / 总额',
			footerRealms: '分域显示',
			footerRemaining: '仅剩余',
			footerHidden: '不显示',
			footerHint2: '窄轨（56px）下只显示 WB，鼠标悬停或点开看明细。',
			on: '开',
			off: '关',
			dismiss: '知道了',
			imageCap: '图片',
			panelDefault: '（面板默认）',
			otherRealm: '其他',
			justNow: '刚刚',
			minutesAgo: '{n} 分钟前',
			hoursAgo: '{n} 小时前',
			alertJoin: '：',
			alertAuthTitle: '面板 API Key 失效',
			alertAuthDetail: '{error}',
			alertUnreachableTitle: '面板连续不可达',
			alertUnreachableDetail: '已连续失败 {count} 次：{error}',
			alertLowCreditsTitle: '{realm}额度不足',
			alertLowCreditsDetail: '剩余 {remaining} 积分（阈值 {threshold}）',
			alertExpiryTitle: '积分包即将到期',
			alertExpiryDetail: '{count} 个包将在 {daysLeft} 天内到期（{account} · {name} 剩 {remain}）',
			realmCn: '国内版',
			realmGlobal: '国际版',
			clearButton: '清除插件写入的配置',
			clearArmed: '再点一次确认清除（会从 DSH 里移除这条 provider）',
			clearConfirm: '确认清除？',
			clearHint: '清除后插件停止自动同步，已写进 DSH 的 workbuddy2api 路由会被整条移除。',
			usageWindow: '统计窗口',
			hours: '小时',
			requests: '请求',
			tokens: 'Token',
			creditsUsed: '消耗积分',
			cacheHit: '缓存命中',
			latency: '平均延迟',
			models: '模型',
			modelsHint: '勾选要出现在 DSH 模型选择器里的模型；点档位可以只保留其中几档。',
			modelName: '模型',
			rate: '倍率',
			context: '上下文',
			efforts: '思考档位',
			noModels: '还没有取到模型。先填面板地址并测试连接。',
			enabledAll: '全选',
			disabledAll: '全不选',
			lastSync: '上次同步',
			never: '尚未同步',
			syncedCount: '已写入 DSH 的模型数',
			syncPendingHint: '有一轮同步被宿主的配置事务挡住了，正在等待补写；模型可能在下次刷新后出现。',
			panelVersion: '面板版本',
			noKey: '缺少 API Key',
			probeFound: '已找到面板',
			probeNone: '没有探测到面板',
			probeCandidates: '探测过的地址',
			error: '错误',
			ok: '正常',
			effortOff: '关闭思考',
			effortNote: '面板会把「关闭思考」抬到该模型最低档，所以这里不提供真正关闭。',
			reloadHint: '模型改动即时生效，无需重启 DSH。',
			usageEmpty: '这个窗口内还没有调用记录。',
			topModels: '模型用量 Top',
		}

		const en = {
			nav: 'WorkBuddy Panel',
			title: 'WorkBuddy Panel',
			subtitle: 'Bring workbuddy2api-panel models into DSH, with quota and usage.',
			connected: 'Connected',
			disconnected: 'Not connected',
			connecting: 'Connecting…',
			panelUrl: 'Panel URL',
			panelUrlHint: 'e.g. http://192.168.1.10:7863 (/v1 or /panel suffixes are corrected)',
			apiKey: 'Panel API key',
			apiKeyHint: 'Stored in the credential store, never in the settings file. Leave blank to keep the current key.',
			apiKeySet: 'A key is configured',
			apiKeyUnset: 'No key configured (fine when the panel has no auth)',
			probe: 'Auto-detect',
			probing: 'Detecting…',
			test: 'Test connection',
			save: 'Save and sync',
			saving: 'Saving…',
			refresh: 'Refresh',
			refreshing: 'Refreshing…',
			syncOn: 'Sync models to DSH',
			syncHint: 'Rewrite the DSH model list whenever the panel changes',
			quota: 'Remaining quota',
			cn: 'China',
			global: 'Global',
			accounts: 'accounts',
			healthy: 'healthy',
			cooling: 'cooling',
			disabled: 'disabled',
			credits: 'credits',
			usage: 'Usage',
			poolNote: 'Usage and credits cover the whole account pool, including other clients on your NAS.',
			footerLabel: 'WorkBuddy credits',
			footerHint: 'Details in Settings → WorkBuddy panel',
			alertsCount: 'alerts pending',
			addressesHint: 'One address per line, tried in order; append a timeout in seconds (e.g. http://nas:7863 8)',
			activeAddress: 'Active',
			retired: 'Removed',
			removeNow: 'Remove now',
			newModels: 'New models on panel',
			newModelsHint: 'These appeared on the panel and are not in the DSH picker yet.',
			enableAllNew: 'Enable all',
			policyTitle: 'Policy',
			newModelPolicy: 'New models',
			policySelect: 'Auto-select',
			policyIgnore: 'Leave off',
			policyNotify: 'Notify only',
			lowCreditMark: 'Low-credit badge',
			footerSection: 'Sidebar badge',
			footerRatio: 'Remaining / total',
			footerRealms: 'Per realm',
			footerRemaining: 'Remaining only',
			footerHidden: 'Hidden',
			footerHint2: 'In the 56px rail only "WB" is shown; hover or click for details.',
			on: 'on',
			off: 'off',
			dismiss: 'Dismiss',
			imageCap: 'image',
			panelDefault: ' (panel default)',
			otherRealm: 'Other',
			justNow: 'just now',
			minutesAgo: '{n} min ago',
			hoursAgo: '{n} h ago',
			alertJoin: ': ',
			alertAuthTitle: 'Panel API key rejected',
			alertAuthDetail: '{error}',
			alertUnreachableTitle: 'Panel unreachable',
			alertUnreachableDetail: 'Failed {count} times in a row: {error}',
			alertLowCreditsTitle: 'Low {realm} credits',
			alertLowCreditsDetail: '{remaining} credits left (threshold {threshold})',
			alertExpiryTitle: 'Credit package expiring',
			alertExpiryDetail: '{count} package(s) expiring within {daysLeft} days ({account} · {name}, {remain} left)',
			realmCn: 'China',
			realmGlobal: 'Global',
			clearButton: 'Remove config written by this plugin',
			clearArmed: 'Click again to confirm (removes the provider from DSH)',
			clearConfirm: 'Confirm removal?',
			clearHint: 'Removes the whole workbuddy2api route from DSH and stops auto-sync.',
			usageWindow: 'Window',
			hours: 'hours',
			requests: 'Requests',
			tokens: 'Tokens',
			creditsUsed: 'Credits',
			cacheHit: 'Cache hit',
			latency: 'Avg latency',
			models: 'Models',
			modelsHint: 'Pick the models that appear in the DSH model picker; click a level to keep only some of them.',
			modelName: 'Model',
			rate: 'Rate',
			context: 'Context',
			efforts: 'Thinking levels',
			noModels: 'No models yet. Enter the panel URL and test the connection.',
			enabledAll: 'Select all',
			disabledAll: 'Select none',
			lastSync: 'Last sync',
			never: 'never',
			syncedCount: 'Models written to DSH',
			syncPendingHint: 'A sync round was blocked by the host config transaction; it will be retried. Models may appear after the next refresh.',
			panelVersion: 'Panel version',
			noKey: 'Missing API key',
			probeFound: 'Panel found',
			probeNone: 'No panel detected',
			probeCandidates: 'Probed addresses',
			error: 'Error',
			ok: 'OK',
			effortOff: 'Thinking off',
			effortNote: 'The panel clamps "off" to the lowest supported level, so true off is not offered here.',
			reloadHint: 'Model changes apply immediately; no DSH restart needed.',
			usageEmpty: 'No calls in this window yet.',
			topModels: 'Top models by usage',
		}

		/** 主题色板：全部走宿主暴露的 CSS 变量，跟随明暗主题。 */
		const C = {
			label: 'var(--dsw-alias-label-primary, currentColor)',
			secondary: 'var(--dsw-alias-label-secondary, #666)',
			tertiary: 'var(--dsw-alias-label-tertiary, #999)',
			layer: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03))',
			hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))',
			border: 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.25))',
			success: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
			warn: 'var(--dsw-alias-state-warn-primary, #d18b00)',
			danger: 'var(--dsw-alias-state-error-primary, #d33)',
			radius: 'var(--dsw-radius-md, 8px)',
			radiusSm: 'var(--dsw-radius-sm, 6px)',
			mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
		}

		/**
		 * 把插件 HTTP 接口路径解析成同源 URL。
		 *
		 * GUI 可能挂在子路径下，所以相对 `document.baseURI` 解析，而不是硬编码 `/`。
		 * @param path - 相对 `workbuddy-panel/api` 的路径。
		 * @returns 可直接 fetch 的路径。
		 */
		function apiPath(path) {
			const url = new URL(`workbuddy-panel/api/${path.replace(/^\/+/, '')}`, document.baseURI)
			// 只取 pathname 会把 `?hours=24` 丢掉：用量窗口就是靠查询串传的，
			// 丢了之后后端会回退到默认 72 小时，界面上却还写着 24h。
			return `${url.pathname}${url.search}`
		}

		/** 单次接口调用的超时。挂死的请求会让 busy 永远不复位。 */
		const API_TIMEOUT_MS = 15000

		/** 超时用的 signal；老浏览器不支持就返回 undefined（此时只能靠网络自己超时）。 */
		function timeoutSignal(ms = API_TIMEOUT_MS) {
			try {
				if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
			} catch {
				// 忽略：没有 AbortSignal.timeout 的环境继续跑。
			}
			return undefined
		}

		/**
		 * 发一次请求并把响应解析成 JSON。
		 * @param path - 接口路径。
		 * @param init - fetch 参数。
		 * @param options.allow304 - 把 304 视为「没变化」返回 null，而不是错误。
		 * @param options.onResponse - 拿到响应头就能用的钩子（ETag 要在读 body 前取）。
		 * @returns 解析后的 JSON；304 且 allow304 时返回 null。
		 */
		async function requestJson(path, init, options = {}) {
			let response
			try {
				response = await fetch(apiPath(path), { ...init, signal: timeoutSignal() })
			} catch (error) {
				// AbortSignal.timeout 抛的是 TimeoutError，手动 abort 抛 AbortError。
				const name = error?.name ?? ''
				if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`接口超时（${API_TIMEOUT_MS / 1000} 秒没有响应）`)
				throw error
			}
			if (typeof options.onResponse === 'function') options.onResponse(response)
			if (options.allow304 === true && response.status === 304) return null
			const text = await response.text()
			let parsed
			try {
				parsed = JSON.parse(text)
			} catch {
				throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`)
			}
			if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}`)
			return parsed
		}

		/**
		 * 调一次插件接口。
		 * @param path - 接口路径。
		 * @param body - POST 请求体；省略则 GET。
		 * @returns 解析后的 JSON。
		 */
		function api(path, body) {
			if (body === undefined) return requestJson(path, { headers: { accept: 'application/json' } })
			return requestJson(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body),
			})
		}

		/** 上一次 /state 的 ETag；命中 304 就不用再解析 30KB 的快照。 */
		let stateEtag = ''

		/**
		 * 读一次状态快照，内容没变时服务端回 304。
		 *
		 * 53 个模型的完整快照约 30KB，15 秒一轮里绝大多数时候什么都没变；
		 * 带上一次拿到的 ETag，没变化就是一个空响应。
		 * @returns 快照对象；304 时返回 null。
		 */
		async function fetchState() {
			const headers = { accept: 'application/json' }
			if (stateEtag !== '') headers['if-none-match'] = stateEtag
			return requestJson('state', { headers }, {
				allow304: true,
				onResponse: (response) => {
					const etag = typeof response.headers?.get === 'function' ? response.headers.get('etag') : ''
					if (typeof etag === 'string' && etag !== '') stateEtag = etag
				},
			})
		}

		/** 千分位数字。 */
		function num(value) {
			const number = Number(value)
			if (!Number.isFinite(number)) return '—'
			return number.toLocaleString('zh-CN')
		}

		/** 徽标里的域简称：国内 / 国际。 */
		function realmShort(realm, label) {
			const stripped = String(label ?? '').replace(/版$/, '')
			if (stripped !== '') return stripped
			if (realm === 'cn') return '国内'
			if (realm === 'global') return '国际'
			return typeof realm === 'string' && realm !== '' ? realm : '—'
		}

		/**
		 * 侧边栏徽标文案。
		 * @param mode - `ratio` 剩余/总额、`realms` 分域、`remaining` 仅剩余、`hidden` 不显示。
		 */
		function footerText(mode, realms, remaining, totalAll) {
			if (mode === 'hidden') return ''
			const list = Array.isArray(realms) ? realms : []
			if (mode === 'realms') {
				const parts = list
					.filter((item) => item && (item.realm === 'cn' || item.realm === 'global'))
					.map((item) => `${realmShort(item.realm, item.label)} ${shortNum(item.credits)}`)
				return parts.length > 0 ? parts.join(' · ') : shortNum(remaining)
			}
			if (mode === 'remaining') return shortNum(remaining)
			const left = shortNum(remaining)
			const right = totalAll === undefined || totalAll === null ? '' : shortNum(totalAll)
			return right === '' || right === left ? left : `${left} / ${right}`
		}

		/** 把积分数量压成短写：12345 → 12.3k。 */
		function shortNum(value) {
			const number = Number(value)
			if (!Number.isFinite(number)) return '—'
			if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(1)}M`
			if (Math.abs(number) >= 1e4) return `${(number / 1e3).toFixed(1)}k`
			return num(Math.round(number * 100) / 100)
		}

		/**
		 * 把毫秒时间戳格式化成「刚刚 / x 分钟前 / 时间」。
		 * @param ms - 时间戳。
		 * @param t - 翻译函数；不传就退回中文（内部调用点都传）。
		 * @param locale - 绝对时间的区域设置。
		 */
		function timeAgo(ms, t = (key) => key, locale = 'zh-CN') {
			const value = Number(ms)
			if (!Number.isFinite(value) || value <= 0) return ''
			const delta = Date.now() - value
			if (delta < 60_000) return t('justNow')
			if (delta < 3_600_000) return String(t('minutesAgo')).replace('{n}', String(Math.floor(delta / 60_000)))
			if (delta < 86_400_000) return String(t('hoursAgo')).replace('{n}', String(Math.floor(delta / 3_600_000)))
			return new Date(value).toLocaleString(locale, { hour12: false })
		}

		/**
		 * 把服务端告警渲染成当前语言的句子。
		 *
		 * 服务端同时给中文文案（老前端与日志用）和 `titleKey`/`detailKey` + `params`；
		 * 词典里查不到（版本偏斜）就退回中文文案，不至于显示成 key。
		 * @param alert - computeAlerts 的产物。
		 * @param t - 翻译函数。
		 * @returns 一行文本。
		 */
		function localizeAlert(alert, t) {
			const pick = (keyField, textField) => {
				const key = typeof alert?.[keyField] === 'string' ? alert[keyField] : ''
				const fallback = typeof alert?.[textField] === 'string' ? alert[textField] : ''
				if (key === '') return fallback
				const template = String(t(key))
				if (template === key) return fallback
				const params = alert.params ?? {}
				return template.replace(/\{(\w+)\}/g, (match, name) => {
					if (name === 'realm') {
						if (params.realm === 'cn') return String(t('realmCn'))
						if (params.realm === 'global') return String(t('realmGlobal'))
						return typeof params.realmLabel === 'string' ? params.realmLabel : match
					}
					return params[name] === undefined ? match : String(params[name])
				})
			}
			const title = pick('titleKey', 'title')
			const detail = pick('detailKey', 'detail')
			if (detail === '') return title
			return `${title}${t('alertJoin')}${detail}`
		}

		/** 上下文窗口的短写：200000 → 200K。 */
		function contextText(tokens) {
			const value = Number(tokens)
			if (!Number.isFinite(value) || value <= 0) return ''
			if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
			if (value >= 1000) return `${Math.round(value / 1000)}K`
			return String(value)
		}

		//#region 样式
		/** 卡片容器。 */
		const S = {
			page: {
				display: 'flex',
				flexDirection: 'column',
				gap: 16,
				color: C.label,
				fontSize: 'var(--dsw-font-sm-14, 14px)',
				paddingBottom: 32,
			},
			card: {
				border: `1px solid ${C.border}`,
				borderRadius: C.radius,
				padding: 16,
				display: 'flex',
				flexDirection: 'column',
				gap: 12,
				background: C.layer,
			},
			header: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: 12,
			},
			title: {
				fontSize: 'var(--dsw-font-md-16, 16px)',
				fontWeight: 600,
				margin: 0,
			},
			subtitle: {
				margin: 0,
				color: C.secondary,
				fontSize: 'var(--dsw-font-xs-13, 13px)',
				lineHeight: 1.5,
			},
			row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
			field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px', minWidth: 180 },
			fieldLabel: { fontSize: 'var(--dsw-font-xs-13, 13px)', color: C.secondary },
			input: {
				width: '100%',
				boxSizing: 'border-box',
				padding: '7px 10px',
				borderRadius: C.radiusSm,
				border: `1px solid ${C.border}`,
				background: 'transparent',
				color: C.label,
				fontSize: 'var(--dsw-font-sm-14, 14px)',
				outline: 'none',
			},
			stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 },
			stat: {
				border: `1px solid ${C.border}`,
				borderRadius: C.radiusSm,
				padding: '10px 12px',
				display: 'flex',
				flexDirection: 'column',
				gap: 2,
				background: 'transparent',
			},
			statLabel: { fontSize: 'var(--dsw-font-xs-12, 12px)', color: C.tertiary },
			statValue: { fontSize: 'var(--dsw-font-md-18, 18px)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
			statHint: { fontSize: 'var(--dsw-font-xs-12, 12px)', color: C.secondary },
			groupTitle: {
				fontSize: 'var(--dsw-font-xs-13, 13px)',
				fontWeight: 600,
				color: C.secondary,
				marginTop: 4,
				display: 'flex',
				alignItems: 'center',
				gap: 8,
			},
			modelRow: {
				display: 'flex',
				alignItems: 'center',
				gap: 10,
				padding: '8px 10px',
				borderRadius: C.radiusSm,
				border: `1px solid transparent`,
			},
			modelName: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
			modelNameText: {
				fontWeight: 500,
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			modelMeta: { fontSize: 'var(--dsw-font-xs-12, 12px)', color: C.tertiary, display: 'flex', gap: 8, flexWrap: 'wrap' },
			efforts: { display: 'flex', gap: 4, flexWrap: 'wrap' },
			table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--dsw-font-xs-13, 13px)' },
			th: { textAlign: 'left', color: C.tertiary, fontWeight: 500, padding: '6px 8px', borderBottom: `1px solid ${C.border}` },
			td: { padding: '6px 8px', borderBottom: `1px solid ${C.border}`, fontVariantNumeric: 'tabular-nums' },
			mono: { fontFamily: C.mono, fontSize: 'var(--dsw-font-xs-12, 12px)' },
			banner: {
				borderRadius: C.radiusSm,
				padding: '8px 10px',
				fontSize: 'var(--dsw-font-xs-13, 13px)',
				lineHeight: 1.5,
			},
			muted: { color: C.tertiary, fontSize: 'var(--dsw-font-xs-12, 12px)' },
		}
		//#endregion

		/** 状态徽标。 */
		function StatusTag(props) {
			const tone = props.tone ?? 'neutral'
			const color = tone === 'success' ? C.success : tone === 'danger' ? C.danger : tone === 'warn' ? C.warn : C.secondary
			return h(
				'span',
				{
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						gap: 5,
						padding: '2px 8px',
						borderRadius: 999,
						border: `1px solid ${color}`,
						color,
						fontSize: 'var(--dsw-font-xs-12, 12px)',
						whiteSpace: 'nowrap',
					},
				},
				h('span', { style: { width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' } }),
				props.children,
			)
		}

		/** 小号可点按钮（不依赖 primitives 的样式差异）。 */
		function Chip(props) {
			const active = props.active === true
			return h(
				'button',
				{
					type: 'button',
					title: props.title,
					disabled: props.disabled === true,
					onClick: props.onClick,
					// 屏幕阅读器要知道「当前选中的是哪一个」，纯靠边框颜色不行。
					'aria-pressed': active,
					style: {
						cursor: props.disabled === true ? 'default' : 'pointer',
						padding: '2px 9px',
						borderRadius: 999,
						fontSize: 'var(--dsw-font-xs-12, 12px)',
						border: `1px solid ${active ? C.success : C.border}`,
						background: 'transparent',
						color: active ? C.success : C.tertiary,
						opacity: props.disabled === true ? 0.5 : 1,
						lineHeight: 1.6,
					},
				},
				props.children,
			)
		}

		/** 一个统计块。 */
		function Stat(props) {
			return h(
				'div',
				{ style: S.stat },
				h('span', { style: S.statLabel }, props.label),
				h('span', { style: { ...S.statValue, color: props.color ?? C.label } }, props.value),
				props.hint === undefined ? null : h('span', { style: S.statHint }, props.hint),
			)
		}

		/**
		 * 设置页里的 WorkBuddy 面板卡片。
		 *
		 * 所有数据都来自插件自己的 HTTP 接口（`/workbuddy-panel/api/*`），
		 * 因此不依赖宿主的 configForms，面板状态变更也不需要重启 DSH。
		 * @param props - 插槽注入的 `{ t }`。
		 * @returns 卡片元素。
		 */
		function WorkBuddyPanel(props) {
			const { t } = props
			const [snap, setSnap] = react.useState(null)
			const [error, setError] = react.useState('')
			const [notice, setNotice] = react.useState('')
			const [busy, setBusy] = react.useState('')
			const [addresses, setAddresses] = react.useState('')
			const [key, setKey] = react.useState('')
			const [hours, setHours] = react.useState(72)
			const [probe, setProbe] = react.useState(null)
			const [clearArmed, setClearArmed] = react.useState(false)
			const alive = react.useRef(true)
			/** 快照序号：轮询结果回来时用它判断自己是否已经过期。 */
			const seq = react.useRef(0)

			react.useEffect(() => {
				alive.current = true
				return () => {
					alive.current = false
				}
			}, [])

			/** 地址列表 → textarea 文本（`地址 [超时秒]` 每行一条）。 */
			const formatAddresses = (entries) =>
				(Array.isArray(entries) ? entries : [])
					.map((entry) => {
						const url = typeof entry === 'string' ? entry : entry?.url
						if (typeof url !== 'string' || url === '') return ''
						const seconds = (Number(typeof entry === 'string' ? 0 : entry?.timeoutMs) || 0) / 1000
						return seconds > 0 ? `${url} ${seconds}` : url
					})
					.filter((line) => line !== '')
					.join('\n')

			/** textarea 文本 → 第一个地址（测试/探测接口用）。 */
			const firstAddress = () => {
				for (const line of addresses.split(/\r?\n/)) {
					const text = line.trim()
					if (text === '' || text.startsWith('#')) continue
					return text.split(/\s+/)[0]
				}
				return ''
			}

			const apply = react.useCallback((next) => {
				if (!alive.current || next === null || typeof next !== 'object') return
				// 序号 +1：还在路上的轮询请求回来时会发现自己已经过期，不会拿旧快照
				// 盖掉刚提交的勾选/策略（这是「勾了又弹回去」的根因）。
				seq.current += 1
				setSnap(next)
				// 广播给侧边栏徽标：改完显示方式不该等下一轮轮询。
				store.set(next)
				setAddresses((current) => (current === '' ? formatAddresses(next.addresses ?? (next.panelUrl ? [next.panelUrl] : [])) : current))
			}, [])

			const load = react.useCallback(async () => {
				const mine = seq.current
				try {
					const next = await fetchState()
					// 请求发出后用户又提交了操作：这份响应是旧数据，直接丢掉。
					if (mine !== seq.current) return
					// 304：内容和上次一样，保留现有快照即可。
					if (next !== null) apply(next)
					setError('')
				} catch (failure) {
					if (alive.current) setError(failure.message)
				}
			}, [apply])

			react.useEffect(() => {
				load()
				// 宿主侧每 2 分钟轮询一次面板，这里 15 秒读一次缓存，体感是实时的。
				const timer = setInterval(load, 15_000)
				return () => clearInterval(timer)
			}, [load])

			/** 成功提示自动消失，别一直挂在页面上。 */
			react.useEffect(() => {
				if (notice === '') return undefined
				const timer = setTimeout(() => setNotice(''), 4000)
				return () => clearTimeout(timer)
			}, [notice])

			/**
			 * 「再点一次确认清除」不能一直挂着红框。
			 *
			 * 不复位的话，用户过十分钟回来随便点一下，配置就真没了。
			 */
			react.useEffect(() => {
				if (!clearArmed) return undefined
				const timer = setTimeout(() => setClearArmed(false), 5000)
				return () => clearTimeout(timer)
			}, [clearArmed])

			/** 包一层 busy 状态，避免重复点击。 */
			const run = react.useCallback(async (tag, task) => {
				setBusy(tag)
				setError('')
				try {
					await task()
				} catch (failure) {
					if (alive.current) setError(failure.message)
				} finally {
					if (alive.current) setBusy('')
				}
			}, [])

			const save = () =>
				run('save', async () => {
					const body = { addresses, refresh: true }
					if (key.trim() !== '') body.apiKey = key.trim()
					const next = await api('config', body)
					apply(next)
					setKey('')
					setNotice(t('ok'))
					await load()
				})

			const test = () =>
				run('test', async () => {
					const result = await api('test', { panelUrl: firstAddress(), apiKey: key.trim() })
					setProbe({ found: result.ok, url: result.url, reason: result.reason, candidates: [{ url: result.url, ok: result.ok, reason: result.reason }], modelCount: result.modelCount })
					if (!result.ok) setError(result.reason || t('probeNone'))
				})

			const detect = () =>
				run('probe', async () => {
					const result = await api('probe', {})
					setProbe(result)
					if (result.found) {
						setAddresses(result.url)
						await load()
					} else {
						setError(t('probeNone'))
					}
				})

			const refresh = () =>
				run('refresh', async () => {
					const next = await api('refresh', { sync: true })
					apply(next)
					await load()
				})

			const toggleModel = (row, enabled) =>
				run(`model:${row.id}`, async () => {
					apply(await api('selection', { id: row.id, enabled }))
				})

			const toggleEffort = (row, level) => {
				const current = row.selectedEfforts ?? row.efforts
				const next = current.includes(level) ? current.filter((item) => item !== level) : [...current, level]
				// 空数组 = 不裁剪（用面板声明的全部档位），不是「回滚到刚才那档」。
				return run(`effort:${row.id}`, async () => {
					apply(await api('selection', { id: row.id, efforts: next }))
				})
			}

			const bulk = (enabled) =>
				run('bulk', async () => {
					apply(await api('bulk', { enabled }))
				})

			/** 只启用面板新增的模型，不动用户手动关掉的那些。 */
			const enableNew = () =>
				run('enable-new', async () => {
					apply(await api('enable-new', {}))
				})

			const setPolicy = (patch) =>
				run('policy', async () => {
					apply(await api('policy', patch))
				})

			const dismissAlert = (key) =>
				run(`dismiss:${key}`, async () => {
					apply(await api('dismiss', { key }))
				})

			const removeRetired = (id) =>
				run(`retire:${id}`, async () => {
					apply(await api('retire', { id }))
					await load()
				})

			// 两步确认：第一次点只亮红，再点一次才真删。
			const clearConfig = () => {
				if (!clearArmed) {
					setClearArmed(true)
					setNotice(t('clearArmed'))
					return
				}
				run('clear', async () => {
					setClearArmed(false)
					const next = await api('clear', { confirm: true })
					apply(next)
					await load()
				})
			}

			const connected = snap !== null && (snap.models?.length ?? 0) > 0
			// 字段缺失就补默认值：版本偏斜（新前端 + 老插件）时少一个数组不该整块白屏。
			const models = Array.isArray(snap?.models) ? snap.models : []
			const cn = models.filter((row) => row.realm === 'cn')
			const globalModels = models.filter((row) => row.realm === 'global')
			const others = models.filter((row) => row.realm !== 'cn' && row.realm !== 'global')
			// snap 还没到（首次加载）时 quota/usage 是 undefined，统一成 null，
			// 否则下面 `quota === null` 的分支判断会漏掉。
			const quota = snap?.quota ?? null
			const realms = Array.isArray(quota?.realms) ? quota.realms : []
			const quotaTotal = quota?.total ?? null
			const usage = snap?.usage ?? null
			const usageTotals = usage?.totals ?? null
			const usageByModel = Array.isArray(usage?.byModel) ? usage.byModel : []
			const alerts = Array.isArray(snap?.alerts) ? snap.alerts : []

			/** 渲染一组模型。 */
			const renderGroup = (title, rows) => {
				if (rows.length === 0) return null
				return h(
					react.Fragment,
					{ key: title },
					h('div', { style: S.groupTitle }, title, h('span', { style: S.muted }, `${rows.filter((row) => row.enabled).length}/${rows.length}`)),
					rows.map((row) =>
						h(
							'div',
							{
								key: row.id,
								style: { ...S.modelRow, borderColor: row.enabled ? C.border : 'transparent', opacity: row.enabled ? 1 : 0.55 },
								onMouseEnter: (event) => {
									event.currentTarget.style.background = C.hover
								},
								onMouseLeave: (event) => {
									event.currentTarget.style.background = 'transparent'
								},
							},
							h(Checkbox, {
								checked: row.enabled,
								disabled: busy !== '',
								onChange: (checked) => toggleModel(row, checked),
								'aria-label': row.displayName,
							}),
							h(
								'div',
								{ style: S.modelName },
								h('span', { style: S.modelNameText, title: row.description || row.id }, row.name),
								h(
									'div',
									{ style: S.modelMeta },
									h('span', { style: S.mono }, row.id),
									row.contextWindow > 0 ? h('span', null, `${t('context')} ${contextText(row.contextWindow)}`) : null,
									row.maxTokens > 0 ? h('span', null, `max ${contextText(row.maxTokens)}`) : null,
									row.supportsImages ? h('span', null, t('imageCap')) : null,
									row.promoLabel !== '' ? h('span', { style: { color: C.warn } }, row.promoLabel) : null,
								),
							),
							row.rate !== '' ? h(StatusTag, { tone: 'neutral' }, `×${row.rate}`) : null,
							row.retired ? h(StatusTag, { tone: 'danger' }, t('retired')) : null,
							row.retired
								? h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '', onClick: () => removeRetired(row.id) }, t('removeNow'))
								: null,
							row.efforts.length > 0
								? h(
										'div',
										{ style: S.efforts, title: t('efforts') },
										row.efforts.map((level) => {
											const picked = row.selectedEfforts ?? row.efforts
											return h(
												Chip,
												{
													key: level,
													active: picked.includes(level),
													disabled: busy !== '',
													title: level === row.defaultEffort ? `${level}${t('panelDefault')}` : level,
													onClick: () => toggleEffort(row, level),
												},
												level,
											)
										}),
									)
								: null,
						),
					),
				)
			}

			return h(
				'div',
				{ style: S.page },
				h(
					'div',
					{ style: S.header },
					h(
						'div',
						null,
						h('h2', { style: S.title }, t('title')),
						h('p', { style: S.subtitle }, t('subtitle')),
					),
					h(
						'div',
						{ style: S.row },
						connected
							? h(StatusTag, { tone: 'success' }, t('connected'))
							: h(StatusTag, { tone: snap === null ? 'neutral' : 'danger' }, snap === null ? t('connecting') : t('disconnected')),
						snap?.panelVersion ? h('span', { style: S.muted }, `v${snap.panelVersion}`) : null,
						h(
							Button,
							{ variant: 'outline', size: 'sm', disabled: busy !== '', onClick: refresh },
							busy === 'refresh' ? t('refreshing') : t('refresh'),
						),
					),
				),

				error !== ''
					? h('div', { style: { ...S.banner, border: `1px solid ${C.danger}`, color: C.danger } }, `${t('error')}：${error}`)
					: null,

				notice !== ''
					? h('div', { style: { ...S.banner, border: `1px solid ${C.border}`, color: C.label } }, notice)
					: null,

				// —— 告警（Key 失效 / 面板不可达 / 额度见底 / 积分包到期）——
				alerts.map((alert) =>
					h(
						'div',
						{
							key: alert.key,
							style: {
								...S.banner,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: 8,
								border: `1px solid ${alert.level === 'error' ? C.danger : C.warn}`,
								color: alert.level === 'error' ? C.danger : C.warn,
							},
						},
						h('span', null, localizeAlert(alert, t)),
						h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '', onClick: () => dismissAlert(alert.key) }, t('dismiss')),
					),
				),

				// —— 连接 ——
				h(
					'div',
					{ style: S.card },
					h(
						'div',
						{ style: S.row },
						h(
							'div',
							{ style: S.field },
							h('span', { style: S.fieldLabel }, t('panelUrl')),
							h('textarea', {
								style: { ...S.input, minHeight: 68, resize: 'vertical', fontFamily: 'var(--dsw-font-mono, monospace)' },
								value: addresses,
								placeholder: 'http://127.0.0.1:7863',
								spellCheck: false,
								rows: 3,
								onChange: (event) => setAddresses(event.target.value),
							}),
							h(
								'span',
								{ style: S.muted },
								t('addressesHint'),
								snap?.activeUrl ? ` · ${t('activeAddress')}：${snap.activeUrl}` : '',
							),
						),
						h(
							'div',
							{ style: S.field },
							h('span', { style: S.fieldLabel }, t('apiKey')),
							h('input', {
								style: S.input,
								type: 'password',
								value: key,
								placeholder: snap?.apiKeyEnv ? `apiKeyEnv: ${snap.apiKeyEnv}` : 'sk-...',
								onChange: (event) => setKey(event.target.value),
							}),
							h('span', { style: S.muted }, t('apiKeyHint')),
						),
					),
					h(
						'div',
						{ style: S.row },
						h(Button, { variant: 'primary', size: 'sm', disabled: busy !== '', onClick: save }, busy === 'save' ? t('saving') : t('save')),
						h(Button, { variant: 'outline', size: 'sm', disabled: busy !== '', onClick: test }, t('test')),
						h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '', onClick: detect }, busy === 'probe' ? t('probing') : t('probe')),
						snap !== null
							? h(
									'label',
									{ style: { ...S.row, marginLeft: 'auto', cursor: 'pointer' }, title: t('syncHint') },
									h(Switch, {
										checked: snap.sync !== false,
										onChange: (checked) =>
											run('sync', async () => {
												apply(await api('config', { sync: checked, refresh: false }))
											}),
										label: t('syncOn'),
									}),
								)
							: null,
					),
					probe !== null
						? h(
								'div',
								{ style: S.muted },
								probe.found
									? `${t('probeFound')}：${probe.url}`
									: `${t('probeNone')}${Array.isArray(probe.candidates) ? `（${probe.candidates.map((item) => item.url).join('、')}）` : ''}`,
							)
						: null,
					snap !== null && snap.lastSyncAt > 0
						? h(
								'div',
								{ style: S.muted },
								`${t('lastSync')}：${timeAgo(snap.lastSyncAt, t)} · ${t('syncedCount')} ${snap.lastSyncCount}`,
								snap.lastSyncError ? h('span', { style: { color: C.danger } }, ` · ${snap.lastSyncError}`) : null,
								` · ${t('reloadHint')}`,
							)
						: null,
					// 同步被 HMR 事务挡掉过、还没补写：说清楚「为什么模型列表没变」。
					snap?.syncPending === true ? h('div', { style: { ...S.muted, color: C.warn } }, t('syncPendingHint')) : null,
				),

				// —— 额度 ——
				h(
					'div',
					{ style: S.card },
					h('div', { style: S.groupTitle }, t('quota')),
					quota === null
						? h('div', { style: S.muted }, connected ? '…' : t('noModels'))
						: h(
								react.Fragment,
								null,
								h(
									'div',
									{ style: S.stats },
									realms.map((realm) =>
										h(Stat, {
											key: realm.realm,
											label: realm.label,
											value: shortNum(realm.credits),
											hint: `${realm.accounts} ${t('accounts')} · ${realm.healthy} ${t('healthy')}${realm.cooling > 0 ? ` · ${realm.cooling} ${t('cooling')}` : ''}${realm.disabled > 0 ? ` · ${realm.disabled} ${t('disabled')}` : ''}`,
										}),
									),
									h(Stat, {
										label: t('accounts'),
										value: String(quotaTotal?.accounts ?? 0),
										hint: `${quotaTotal?.healthy ?? 0} ${t('healthy')} / ${quotaTotal?.cooling ?? 0} ${t('cooling')}`,
										color: (quotaTotal?.healthy ?? 0) === 0 ? C.warn : C.label,
									}),
									usage === null
										? null
										: h(Stat, {
												label: `${t('requests')} · ${hours}h`,
												value: num(usageTotals?.requests),
												hint: `${t('creditsUsed')} ${shortNum(usageTotals?.credits)}`,
											}),
									usage === null
										? null
										: h(Stat, {
												label: t('cacheHit'),
												value: `${Math.round((usageTotals?.cacheHitRate || 0) * 100)}%`,
												hint: `${t('latency')} ${Math.round(usageTotals?.avgLatencyMs || 0)}ms`,
											}),
								),
								snap?.accounts?.length > 0
									? h(
											'div',
											{ style: { display: 'flex', flexDirection: 'column', gap: 2 } },
											snap.accounts.slice(0, 8).map((account) =>
												h(
													'div',
													{ key: account.uid || account.nickname, style: { ...S.row, fontSize: 'var(--dsw-font-xs-13, 13px)' } },
													h(StatusTag, { tone: account.disabled ? 'danger' : account.cooling ? 'warn' : 'success' }, account.nickname || account.uid || '?'),
													h('span', { style: S.muted }, account.realm === 'cn' ? t('cn') : account.realm === 'global' ? t('global') : account.realm),
													h('span', { style: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' } }, `${shortNum(account.credits)} ${t('credits')}`),
													account.cooling && account.coolRemainingSec > 0
														? h('span', { style: { color: C.warn } }, `${Math.round(account.coolRemainingSec / 60)}m`)
														: null,
												),
											),
										)
									: null,
							),
				),

				// 用量口径说明：面板统计的是整池，不是 DSH 自己。
				h('div', { style: { ...S.muted, fontSize: 'var(--dsw-font-xs-13, 13px)' } }, t('poolNote')),

				// —— 模型 ——
				h(
					'div',
					{ style: S.card },
					h(
						'div',
						{ style: S.header },
						h('div', { style: S.groupTitle }, t('models'), h('span', { style: S.muted }, `${snap?.counts?.enabled ?? 0}/${snap?.counts?.total ?? 0}`)),
						h(
							'div',
							{ style: S.row },
							h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '' || models.length === 0, onClick: () => bulk(true) }, t('enabledAll')),
							h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '' || models.length === 0, onClick: () => bulk(false) }, t('disabledAll')),
						),
					),
					h('div', { style: S.muted }, t('modelsHint')),

					(snap?.newModels?.length ?? 0) > 0
						? h(
								'div',
								{
									style: {
										...S.row,
										justifyContent: 'space-between',
										border: `1px solid ${C.warn}`,
										borderRadius: C.radius,
										padding: '8px 12px',
										color: C.warn,
									},
								},
								h('span', null, `${t('newModels')} +${snap.newModels.length} · ${t('newModelsHint')}`),
								h(Button, { variant: 'outline', size: 'sm', disabled: busy !== '', onClick: enableNew }, t('enableAllNew')),
							)
						: null,
					models.length === 0
						? h('div', { style: S.muted }, t('noModels'))
						: h(
								react.Fragment,
								null,
								renderGroup(t('cn'), cn),
								renderGroup(t('global'), globalModels),
								renderGroup(t('otherRealm'), others),
							),
				),

				// —— 用量 ——
				usageByModel.length === 0
					? null
					: h(
							'div',
							{ style: S.card },
							h(
								'div',
								{ style: S.header },
								h('div', { style: S.groupTitle }, t('topModels')),
								h(
									'div',
									{ style: S.row },
									[24, 72, 168].map((value) =>
										h(
											Chip,
											{
												key: value,
												active: hours === value,
												disabled: busy !== '',
												onClick: () =>
													run('usage', async () => {
														const result = await api(`usage?hours=${value}`)
														// 函数式更新：await 期间轮询或别的操作可能已经换过 snapshot，
														// 用闭包里的旧 snap 做 spread 会把它们覆盖回去。
														if (!alive.current) return
														setHours(value)
														setSnap((current) => {
															if (current === null) return current
															const next = { ...current, usage: result.usage }
															store.set(next)
															return next
														})
													}),
											},
											`${value}h`,
										),
									),
								),
							),
							h(
								'table',
								{ style: S.table },
								h(
									'thead',
									null,
									h(
										'tr',
										null,
										h('th', { style: S.th }, t('modelName')),
										h('th', { style: S.th }, t('requests')),
										h('th', { style: S.th }, t('tokens')),
										h('th', { style: S.th }, t('creditsUsed')),
									),
								),
								h(
									'tbody',
									null,
									usageByModel.map((row) =>
										h(
											'tr',
											{ key: row.key },
											h('td', { style: { ...S.td, ...S.mono } }, row.key),
											h('td', { style: S.td }, num(row.requests)),
											h('td', { style: S.td }, shortNum(row.tokens)),
											h('td', { style: S.td }, shortNum(row.credits)),
										),
									),
								),
							),
						),

				// —— 策略与危险操作 ——
				// 老宿主（没重启）不会返回 policy，这时整块藏起来，避免点了报 404。
				snap?.policy === undefined
					? null
					: h(
					'div',
					{ style: S.card },
					h('div', { style: S.groupTitle }, t('policyTitle')),
					h(
						'div',
						{ style: S.row },
						h('span', { style: S.fieldLabel }, t('newModelPolicy')),
						[
							['select', t('policySelect')],
							['ignore', t('policyIgnore')],
							['notify', t('policyNotify')],
						].map(([value, label]) =>
							h(
								Chip,
								{
									key: value,
									active: (snap?.policy?.newModelPolicy ?? 'select') === value,
									disabled: busy !== '' || snap === null,
									onClick: () => setPolicy({ newModelPolicy: value }),
								},
								label,
							),
						),
					),
					h(
						'div',
						{ style: S.row },
						h('span', { style: S.fieldLabel }, t('lowCreditMark')),
						h(
							Chip,
							{
								active: snap?.policy?.lowCreditMark !== false,
								disabled: busy !== '' || snap === null,
								onClick: () => setPolicy({ lowCreditMark: snap?.policy?.lowCreditMark === false }),
							},
							snap?.policy?.lowCreditMark === false ? t('off') : t('on'),
						),
					),
					h(
						'div',
						{ style: S.row },
						h('span', { style: S.fieldLabel }, t('footerSection')),
						[
							['ratio', t('footerRatio')],
							['realms', t('footerRealms')],
							['remaining', t('footerRemaining')],
							['hidden', t('footerHidden')],
						].map(([value, label]) =>
							h(
								Chip,
								{
									key: value,
									active: (snap?.policy?.footerMode ?? 'ratio') === value,
									disabled: busy !== '' || snap === null,
									onClick: () => setPolicy({ footerMode: value }),
								},
								label,
							),
						),
					),
					h('div', { style: S.muted }, t('footerHint2')),
					h('div', { style: S.muted }, t('clearHint')),
					h(
						'div',
						{ style: S.row },
						h(
							Button,
							{
								variant: 'outline',
								size: 'sm',
								disabled: busy !== '' || snap === null,
								onClick: clearConfig,
								style: clearArmed ? { borderColor: C.danger, color: C.danger } : undefined,
							},
							clearArmed ? t('clearConfirm') : t('clearButton'),
						),
					),
				),
			)
		}

		/**
		 * 侧边栏底部的小徽标：显示账号池剩余积分，点开看分区明细。
		 *
		 * 挂在 `sidebar.footer.action`（列表插槽，位置在设置按钮旁边）。
		 * 这个插槽只给列状态（`wide`），拿不到「打开设置」的句柄，所以
		 * 明细做成就地浮层，不假装能跳转。
		 * @param props - `{ t, wide }`。
		 * @returns 徽标元素。
		 */
		function WorkBuddyFooter(props) {
			const { t, wide } = props
			const [snap, setSnap] = react.useState(store.get())
			const [open, setOpen] = react.useState(false)
			const [anchor, setAnchor] = react.useState(null)
			const alive = react.useRef(true)
			const popoverRef = react.useRef(null)
			const buttonRef = react.useRef(null)

			react.useEffect(() => {
				alive.current = true
				const load = async () => {
					try {
						// 走 store 而不是直接 setSnap：设置页在另一个根里，也要拿到同一份数据。
						store.set(await api('state'))
					} catch {
						// 宿主刚启动、插件还没就绪时安静失败，下一轮再试。
					}
				}
				const unsubscribe = store.subscribe((next) => {
					if (alive.current) setSnap(next)
				})
				load()
				// 宿主每 2 分钟才拉一次面板，这里 1 分钟读一次内存快照就够了。
				const timer = setInterval(load, 60_000)
				return () => {
					alive.current = false
					unsubscribe()
					clearInterval(timer)
				}
			}, [])

			const quota = snap?.quota ?? null
			const alerts = Array.isArray(snap?.alerts) ? snap.alerts : []
			const hasError = typeof snap?.lastError === 'string' && snap.lastError !== ''
			const total = quota?.total?.credits
			const tone = hasError || alerts.some((item) => item.level === 'error') ? C.danger : alerts.length > 0 ? C.warn : C.success
			const mode = snap?.policy?.footerMode ?? 'ratio'
			const showDot = snap?.policy?.footerDot !== false
			const text = footerText(mode, quota?.realms, total, quota?.total?.creditsTotal)

			const toggle = (event) => {
				if (open) {
					setOpen(false)
					return
				}
				const rect = event.currentTarget.getBoundingClientRect()
				setAnchor({ left: rect.left, top: rect.top })
				setOpen(true)
			}

			/**
			 * 浮层要能自己关掉：Esc 关闭、点浮层外面关闭。
			 *
			 * 只靠「再点一次徽标」在小窗口里很别扭，而且浮层盖在内容上时
			 * 用户第一反应就是点空白处。
			 */
			react.useEffect(() => {
				if (!open) return undefined
				if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
				const onKey = (event) => {
					if (event?.key === 'Escape') setOpen(false)
				}
				const onPointer = (event) => {
					const inside = (ref) => {
						const node = ref.current
						return node !== null && typeof node?.contains === 'function' && node.contains(event?.target)
					}
					// 点徽标自身交给 onClick 处理（否则会「关了又开」）。
					if (inside(popoverRef) || inside(buttonRef)) return
					setOpen(false)
				}
				window.addEventListener('keydown', onKey)
				window.addEventListener('pointerdown', onPointer, true)
				return () => {
					window.removeEventListener('keydown', onKey)
					window.removeEventListener('pointerdown', onPointer, true)
				}
			}, [open])

			const popover =
				open && anchor !== null && typeof window !== 'undefined'
					? h(
							'div',
							{
								ref: popoverRef,
								role: 'dialog',
								'aria-label': t('footerLabel'),
								style: {
									position: 'fixed',
									left: Math.max(8, anchor.left),
									bottom: Math.max(8, window.innerHeight - anchor.top + 8),
									zIndex: 1200,
									minWidth: 240,
									background: C.layer,
									border: `1px solid ${C.border}`,
									borderRadius: C.radius,
									boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
									padding: 12,
									display: 'flex',
									flexDirection: 'column',
									gap: 8,
								},
							},
							h('div', { style: { fontWeight: 600 } }, t('title')),
							(quota?.realms ?? []).map((realm) =>
								h(
									'div',
									{ key: realm.realm, style: { display: 'flex', justifyContent: 'space-between', gap: 16 } },
									h('span', { style: { color: C.secondary } }, realm.label),
									h('span', null, `${shortNum(realm.credits)} / ${shortNum(realm.creditsTotal)}`),
								),
							),
							alerts.length > 0
								? h('div', { style: { color: C.warn } }, `${alerts.length} ${t('alertsCount')}`)
								: null,
							snap?.panelVersion ? h('div', { style: { color: C.secondary, fontSize: 12 } }, `v${snap.panelVersion}`) : null,
							h('div', { style: { color: C.tertiary, fontSize: 12 } }, t('footerHint')),
						)
					: null

			if (mode === 'hidden') return null

			return h(
				react.Fragment,
				null,
				h(
					'button',
					{
						ref: buttonRef,
						type: 'button',
						onClick: toggle,
						'aria-expanded': open,
						title: `${t('footerLabel')}${text === '' ? '' : ` · ${text}`}`,
						style: {
							display: 'flex',
							alignItems: 'center',
							justifyContent: wide ? 'flex-start' : 'center',
							gap: 6,
							width: '100%',
							minWidth: 0,
							padding: wide ? '6px 8px' : '6px 0',
							border: '1px solid transparent',
							borderRadius: 'var(--dsw-radius-sm, 6px)',
							background: 'transparent',
							color: C.label,
							fontSize: 'var(--dsw-font-xs-13, 13px)',
							cursor: 'pointer',
						},
						onMouseEnter: (event) => {
							event.currentTarget.style.background = C.hover
						},
						onMouseLeave: (event) => {
							event.currentTarget.style.background = 'transparent'
						},
					},
					showDot
						? h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: tone, flex: '0 0 auto' } })
						: null,
					wide
						? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text === '' ? 'WB' : `WB ${text}`)
						: h('span', { style: { fontSize: 11 } }, 'WB'),
				),
				popover,
			)
		}

		/**
		 * 挂载设置页分区。
		 * @param ctx - 客户端上下文。
		 */
		/**
		 * 注册一块 UI；失败只影响这一块，不牵连其它块。
		 * @param ctx - 客户端上下文。
		 * @param label - effect 名字（也是日志里的标识）。
		 * @param factory - effect 工厂。
		 */
		function safeEffect(ctx, label, factory) {
			try {
				ctx.effect(factory, label)
			} catch (error) {
				console.error(`[dsh-workbuddy2api-panel] ${label} 注册失败`, error)
			}
		}

		/**
		 * 挂载设置页分区 + 侧边栏徽标。
		 *
		 * 三块各自独立注册：语言包或设置页注册失败，徽标也要照常出现
		 * （反过来也一样），否则一个插槽的接口变化会带走整个插件。
		 * @param ctx - 客户端上下文。
		 */
		function apply(ctx) {
			let t = (key) => key
			try {
				t = ctx.locale.bind(NS)
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workbuddy-panel: dictionaries')
			} catch (error) {
				console.error('[dsh-workbuddy2api-panel] 语言包注册失败，改用原始 key', error)
			}
			safeEffect(
				ctx,
				'workbuddy-panel: settings section',
				() =>
					ctx.slots.inject('settings.section', () =>
						ctx.slots.register(
							{
								name: 'settings.section',
								id: 'workbuddy',
								order: 45,
								label: () => t('nav'),
								locale: NS,
								inject: () => ({ t }),
							},
							(ownerProps = {}) => h(WorkBuddyPanel, { ...ownerProps, t }),
						),
					),
			)
			safeEffect(
				ctx,
				'workbuddy-panel: sidebar footer',
				() =>
					ctx.slots.inject('sidebar.footer.action', () =>
						ctx.slots.register(
							{
								name: 'sidebar.footer.action',
								id: 'workbuddy-quota',
								order: 50,
								label: () => t('footerLabel'),
							},
							(ownerProps = {}) => h(WorkBuddyFooter, { ...ownerProps, t }),
						),
					),
			)
		}

		exports.NS = NS
		// 供测试用：验证「设置页改完 → 徽标立刻变」这条链路。
		exports.__store = store
		// 供测试用：用量窗口是走查询串传的，这里单独暴露出来做断言。
		exports.__apiPath = apiPath
		// 供测试用：Chip 在假 React 里不会被调用，只能直接调它验可访问性属性。
		exports.__Chip = Chip
		exports.apply = apply
		exports.inject = ['slots', 'locale']
		return module.exports
	},
})
