/**
 * 战绩网关客户端。
 *
 * ## 为什么要有「网关」这一层
 *
 * 无畏契约**没有**像王者营地 / 和平精英那样公开可用的免登录查询接口：
 * · 国服：数据在掌上无畏契约 App 里，接口需要 App 的登录态 / 设备参数；
 * · 国际服：需要拳头官方 API key 或者第三方数据站的 key。
 * 这些都**不该也不能写死在插件里**（写死的后果就是 token 一失效全军覆没，
 * 跟早期某些插件抢先看.service 一个下场）。
 *
 * 所以这里跟网关服务（见 `bridge/`）解耦：
 * 插件只认一份**稳定的 REST 契约**，具体数据从哪来，由你部署的网关决定。
 * 默认桥接示例代码是 `demo` provider —— 零配置也能出图，方便先看效果、调 UI。
 *
 * ## 约定响应体
 * ```json
 * { "ok": true,  "data": { ... }, "provider": "demo", "cached": false, "took": 12 }
 * { "ok": false, "error": { "code": "NOT_FOUND", "message": "查无此账号" } }
 * ```
 */
import { gateway } from './config.js'
import { remember } from './cache.js'

/** 带「用户能看懂的原因」的错误 */
export class GatewayError extends Error {
  /**
   * @param {string} message 直接发给用户的话
   * @param {string} code    机器可读的错误码
   */
  constructor (message, code = 'ERROR') {
    super(message)
    this.name = 'GatewayError'
    this.code = code
  }
}

/** 网关配置缺失时的统一提示 */
const NO_GATEWAY_HINT = [
  '当前没配置战绩网关，查不了玩家数据。',
  '在本插件目录下执行 pnpm bridge 起一个示例网关，',
  '然后在 plugins/Valorant-Plugin/config/config/config.yaml 里填：',
  "  gateway.url: 'http://127.0.0.1:7820'",
  "  gateway.token: '你设置的令牌'"
].join('\n')

async function request (endpoint, params = {}, options = {}) {
  const cfg = gateway()

  if (!cfg.url) throw new GatewayError(NO_GATEWAY_HINT, 'NO_GATEWAY')

  const url = new URL(`${cfg.url}${endpoint}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  let res
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(cfg.timeout),
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        ...(options.headers || {})
      }
    })
  } catch (error) {
    // 连不上：网关没起 / 地址写错 / 防火墙
    const reason = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? '请求超时'
      : error.code === 'ECONNREFUSED'
        ? '连接被拒绝（多半是网关没启动）'
        : error.message
    throw new GatewayError(
      `连不上战绩网关：${reason}\n请检查 gateway.url 配置与网关运行状态。`,
      'UNREACHABLE'
    )
  }

  // ⚠️ 先把响应体解析出来，**再**看状态码。
  //    早先是「非 2xx 直接抛通用错误」，于是网关规规矩矩返回的
  //    `404 {ok:false,error:{code:'NOT_FOUND'}}` 被降级成一句
  //    「返回异常状态 404」—— 用户看不到「查不到这个账号」这种有用信息。
  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}

  // 契约内的错误：优先用网关给的原因，它比状态码具体
  if (json && json.ok === false) {
    const { code, message } = json.error || {}
    throw new GatewayError(humanize(code, message), code || 'UPSTREAM')
  }

  if (res.status === 401 || res.status === 403) {
    throw new GatewayError('战绩网关拒绝了本次请求，请检查 gateway.token 是否与网关一致。', 'AUTH')
  }
  if (res.status === 429) {
    throw new GatewayError('查询太频繁了，网关限流中，请稍后再试。', 'RATE_LIMIT')
  }
  if (!res.ok) {
    throw new GatewayError(`战绩网关返回异常状态 ${res.status}。`, 'HTTP')
  }
  if (!json) {
    throw new GatewayError('战绩网关返回的不是合法 JSON，请确认网关版本与插件匹配。', 'BAD_JSON')
  }

  if (!json.data && options.allowEmpty !== true) {
    throw new GatewayError('战绩网关返回的数据为空。', 'EMPTY')
  }

  return json
}

/** 把网关的错误码翻译成人话 */
function humanize (code, message) {
  const text = message || '网关未说明原因'
  switch (code) {
    case 'NOT_FOUND': return `查不到这个账号：${text}`
    // 多账号：这个人还没导入登录态。上游已经把「下一步做什么」写清楚了，别再套前缀
    case 'NOT_BOUND': return text
    case 'PRIVATE': return `对方关闭了战绩公开，${text}`
    case 'AUTH': return `网关令牌不对，请检查 config/config/config.yaml 里的 gateway.token（网关说：${text}）`
    case 'UPSTREAM': return `上游数据源出错了：${text}`
    case 'RATE_LIMIT': return `上游限流了，晚点再试：${text}`
    case 'NOT_SUPPORTED': return `当前数据源不支持这个功能：${text}`
    case 'NOT_CONFIGURED': return `这个扫码方式还没配置好：${text}`
    case 'UPSTREAM_AUTH': return `数据源登录态失效了，请联系机器人主人处理：${text}`
    case 'EMPTY': return `网关没返回数据：${text}`
    case 'BAD_REQUEST': return `请求参数不对：${text}`
    default: return `查询失败：${text}`
  }
}

/** 记录最后一次查询用的是哪个 provider，出图时展示来源 */
let lastProvider = ''

export function getLastProvider () {
  return lastProvider
}

async function cached (key, ttl, fn) {
  return remember(key, ttl, fn)
}

/* ---------------- 具体接口 ---------------- */

/** 网关健康检查（`pnpm bridge` 起来之后可以先用它验证通不通） */
export async function health () {
  return request('/health', {}, { allowEmpty: true })
}

/**
 * 按 Riot ID 找玩家（也可以传 puuid）
 *
 * `user` 是这个人的身份（QQ 号）：网关据此决定用谁的登录态。
 * 传空串就是「网关默认那份」—— 只有 CLI / 单人自用时才该走到这里。
 *
 * @returns {Promise<{ puuid: string, id: string, name: string, tag: string, region: string, accountLevel: number, card: object, title: string }>}
 */
export async function searchAccount (query, region = '', user = '') {
  const key = `account:${user}:${region}:${query}`
  const json = await cached(key, 600, () => request('/v1/account', { q: query, region, user }))
  lastProvider = json.provider || ''
  return json.data
}

/**
 * 生涯数据面板
 * @param {string} account `名称#标签` 或 puuid
 */
export async function getProfile (account, region = '', user = '') {
  const key = `profile:${user}:${region}:${account}`
  const json = await cached(key, 300, () => request('/v1/profile', { account, region, user }))
  lastProvider = json.provider || ''
  return json.data
}

/**
 * 最近战绩列表
 * @param {object} opts { account, region, count, mode, map, user }
 */
export async function getMatches ({ account, region = '', count = 10, mode = '', map = '', user = '' }) {
  const key = `matches:${user}:${region}:${account}:${count}:${mode}:${map}`
  const json = await cached(key, 120, () => request('/v1/matches', { account, region, count, mode, map, user }))
  lastProvider = json.provider || ''
  return json.data
}

/** 单局详情 */
export async function getMatch (matchId, account = '', user = '') {
  const key = `match:${user}:${matchId}:${account}`
  const json = await cached(key, 3600, () => request(`/v1/match/${encodeURIComponent(matchId)}`, { account, user }))
  lastProvider = json.provider || ''
  return json.data
}

/** 枪械熟练度 */
export async function getWeapons ({ account, region = '', season = '', count = 20, user = '' }) {
  const key = `weapons:${user}:${region}:${account}:${season}:${count}`
  const json = await cached(key, 600, () => request('/v1/weapons', { account, region, season, count, user }))
  lastProvider = json.provider || ''
  return json.data
}

/* ---------------- 一人一份登录态 ---------------- */

/** 网关的健康信息（顺便看它支不支持多账号） */
export async function healthInfo () {
  const json = await request('/health', {}, { allowEmpty: true })
  return json.data || {}
}

/**
 * 这个人导入过没有。
 *
 * 网关的响应是 `{users, shared, current}` —— `current` 才是「我」的状态，
 * 别把整个 data 当成状态用（第一版就这么写错，结果永远显示「还没导入」）。
 */
export async function credentialStatus (user) {
  const json = await request('/v1/creds', { user }, { allowEmpty: true })
  return json.data?.current || { bound: false }
}

/**
 * 导入登录态。
 *
 * 掌瓦没有可复现的扫码流程，所以这里的「登录」= 交一份抓包得到的
 * cookie + scene。网关会立刻用它打一次真实请求验证，通不过就不落盘。
 *
 * @param {string} user
 * @param {{cookie: string, scene?: string, sceneDetail?: string}} payload
 */
export async function importCredential (user, payload) {
  const json = await request('/v1/creds', { user }, { method: 'POST', body: { user, ...payload } })
  return json.data
}

/** 解绑：删掉这个人的登录态 */
export async function removeCredential (user) {
  const json = await request('/v1/creds', { user }, {
    method: 'POST',
    body: { user, action: 'remove' }
  })
  return json.data
}

/* ---------------- 扫码登录 ---------------- */

/**
 * 这些接口**不缓存**：登录状态是随时间变的，缓存一秒钟都可能让用户
 * 对着已经变了的二维码发愣（`cached()` 只用于查询类接口）。
 */

/** 网关支持哪些扫码方式（用来提前告诉用户「微信没配」） */
export async function loginAdapters () {
  const json = await request('/v1/login/adapters', {}, { allowEmpty: true })
  return json.data?.adapters || []
}

/**
 * 开一个扫码会话
 * @param {string} type qq / wx / mock
 * @returns {Promise<{sessionId: string, type: string, qr: string, expireIn: number}>}
 */
export async function loginStart (type) {
  const json = await request('/v1/login/start', { type })
  return json.data
}

/**
 * 推进一次轮询并取状态
 * @returns {Promise<{sessionId,type,status,message,qr,profile,leftSeconds}>}
 */
export async function loginPoll (sessionId) {
  const json = await request('/v1/login/poll', { session: sessionId })
  return json.data
}

/** 取消扫码会话 */
export async function loginCancel (sessionId) {
  const json = await request('/v1/login/cancel', { session: sessionId }, { allowEmpty: true })
  return json.data
}

/** 登录成功后把凭证交给网关落库 */
export async function loginCommit (sessionId) {
  const json = await request('/v1/login/commit', { session: sessionId }, { allowEmpty: true })
  return json.data
}
