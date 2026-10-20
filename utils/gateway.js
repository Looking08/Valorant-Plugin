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
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { gateway } from './config.js'
import { remember } from './cache.js'

/** 插件根目录（本文件在 `utils/` 下） */
const PLUGIN_ROOT = path.resolve(new URL('..', import.meta.url).pathname)

/** 自动拉起的那个网关子进程（只可能有一个） */
let localChild = null
/** 上次尝试拉起的时间，防止每次请求都 spawn 一遍 */
let lastSpawnAt = 0
/** 连续拉起失败时给用户看的最后一条原因 */
let lastSpawnError = ''

const SPAWN_COOLDOWN = 60 * 1000

/** 这个地址是不是「本机」—— 只有本机才轮得到我们去拉起 */
function isLocalUrl (url) {
  try {
    const u = new URL(url)
    return ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(u.hostname)
  } catch {
    return false
  }
}

function isRefused (error) {
  return error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED'
}

/**
 * 自动挑数据源：有 `bridge/mate.json`（真凭证）就用 mateapp，否则 demo。
 * 这样「下载即用」的人拿到 demo 也能出图，导入凭证后自动切成真实数据。
 */
function pickProvider () {
  try {
    const file = path.join(PLUGIN_ROOT, 'bridge/mate.json')
    if (!fs.existsSync(file)) return 'demo'
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    return json?.login?.cookie ? 'mateapp' : 'demo'
  } catch {
    return 'demo'
  }
}

/** 等本地网关起来：轮询一个不需要凭证的路由，通了就算成功 */
async function waitUntilUp (baseUrl, token, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/login/adapters`, {
        signal: AbortSignal.timeout(1200),
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      if (res.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

/**
 * 把本地网关拉起来。
 *
 * 只在「地址是本机 + autoStart 开着 + 真的连不上」这三个条件同时成立时才会被调用，
 * 所以远程网关（别人共享给你的那份）永远走不到这里。
 *
 * @returns {Promise<boolean>} 起来了吗
 */
async function startLocalGateway (cfg) {
  if (localChild && localChild.exitCode === null) return waitUntilUp(cfg.url, cfg.token)
  if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN) {
    lastSpawnError = lastSpawnError || '刚刚尝试拉起过，还没到重试时间'
    return false
  }

  const script = path.join(PLUGIN_ROOT, 'bridge/server.mjs')
  if (!fs.existsSync(script)) {
    lastSpawnError = `找不到网关脚本 ${script}`
    return false
  }

  lastSpawnAt = Date.now()
  let port = '7820'
  try { port = new URL(cfg.url).port || '80' } catch {}

  const provider = cfg.provider || pickProvider()

  try {
    localChild = spawn(process.execPath, [script], {
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        PORT: port,
        TOKEN: cfg.token || 'change-me',
        PROVIDER: provider
      },
      stdio: 'ignore'
    })
  } catch (error) {
    lastSpawnError = error.message
    return false
  }

  localChild.on('error', error => { lastSpawnError = error.message })
  localChild.on('exit', code => {
    // 非 0 退出说明它自己起不来（端口占用、凭证坏了），留个原因给用户看
    if (code) lastSpawnError = `网关进程退出（code=${code}），看 bridge 的报错`
    localChild = null
  })

  // 云崽退出时别留孤儿进程
  process.once('exit', () => { try { localChild?.kill() } catch {} })

  const up = await waitUntilUp(cfg.url, cfg.token)
  if (!up) lastSpawnError = lastSpawnError || '拉起后 6 秒内没响应，可能端口被占用'
  else console.log(`[瓦插件] 已自动拉起本地网关：${cfg.url}（数据源 ${provider}）`)
  return up
}

/** 连不上网关时的统一措辞；自动拉起失败要把原因带出来，别只说「连不上」 */
function unreachable (error, triedSpawn = false) {
  const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    ? '请求超时'
    : isRefused(error)
      ? (triedSpawn ? '本地网关没起来' : '连接被拒绝（多半是网关没启动）')
      : (error?.message || '未知网络错误')
  const extra = triedSpawn && lastSpawnError ? `\n自动拉起也没成功：${lastSpawnError}` : ''
  return new GatewayError(
    `连不上战绩网关：${reason}${extra}\n`
    + '请检查 gateway.url 配置，或在本插件目录手动执行 `pnpm bridge`。',
    'UNREACHABLE'
  )
}

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

/**
 * 把云崽的用户标识压成网关能接受的形状。
 *
 * ⚠️ QQ 官方机器人的 `e.user_id` 是 `群号:成员openid` 这种**带冒号**的复合串。
 *    网关把 user 当文件名用（`bridge/accounts/<user>.json`），只放行 `[A-Za-z0-9_-]`，
 *    见到冒号直接 400 BAD_REQUEST。插件这边一旦 400，所有指令都会走到「不认识这个格式」
 *    那种兜底文案上 —— 表现就是「名字没错，但怎么都绑不上」。
 *
 * 所以在**唯一的出口**这里统一压一遍：非法字符换下划线，去掉首尾，限长。
 * 网关那边收到的永远是干净 key，两个存储（UserData 用原始 id，凭证用压缩 key）各管各的。
 */
export function safeUser (user) {
  return String(user ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96)
}

async function request (endpoint, params = {}, options = {}) {
  const cfg = gateway()

  if (!cfg.url) throw new GatewayError(NO_GATEWAY_HINT, 'NO_GATEWAY')

  const url = new URL(`${cfg.url}${endpoint}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    // user 要过一遍压缩：QQ 官方机器人的 id 带冒号，网关不收
    const text = key === 'user' ? safeUser(value) : String(value)
    if (!text) continue
    url.searchParams.set(key, text)
  }

  const send = () => fetch(url, {
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

  let res
  try {
    res = await send()
  } catch (error) {
    // 本机网关没起？按配置尝试拉起来再打一次。
    // 远程网关（别人共享的那份）走不到这里 —— isLocalUrl 会挡掉。
    if (isRefused(error) && cfg.autoStart !== false && isLocalUrl(cfg.url)) {
      const up = await startLocalGateway(cfg).catch(() => false)
      if (!up) throw unreachable(error, true)
      try {
        res = await send()
      } catch (retryError) {
        throw unreachable(retryError, true)
      }
    } else {
      throw unreachable(error, false)
    }
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
 * 这个登录态底下真实绑着的游戏账号。
 *
 * 掌瓦自己的 `/go/auth/bind_relation_list`：认登录态不认昵称，
 * 所以返回的一定是真能查的人，每条还带着 scene（= selfUuid）。
 * 绑不上的时候拿它兜底，比让用户猜昵称靠谱得多。
 *
 * 没配掌瓦数据源（demo）会抛 NOT_SUPPORTED，调用方要接着。
 *
 * @returns {Promise<Array<{index:number, name:string, scene:string, uin:string, thirdType:number, icon:string, verified:boolean}>>}
 */
export async function boundAccounts (user = '') {
  // 短缓存：账号列表几乎不变，但刚导入完要能马上看到
  const json = await cached(`bound:${user}`, 120, () => request('/v1/bound', { user }, { allowEmpty: true }))
  return json.data?.accounts || []
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

/* ---------------- 同过场的玩家 ---------------- */

/**
 * 同过场的人（掌瓦把每人的 scene 发给同场十人，那份 scene 就是「查他」的钥匙）。
 * 陌生人查不到 —— 掌瓦没有按昵称搜人的接口。
 */
export async function listPeers (user = '') {
  const json = await request('/v1/peers', { user }, { allowEmpty: true })
  return json.data || []
}

/** 关掉自己在同场索引里的可见性（可退出） */
export async function hidePeer (user, name = '') {
  const json = await request('/v1/peers', { user }, {
    method: 'POST',
    body: { user, action: 'hide', name }
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
 *
 * `user` 必须带上：登录成功后凭证要落在扫码那个人名下，
 * 不带就会被写进网关部署者自己那份配置里（串号）。
 *
 * @param {string} type qq / wx / mock
 * @param {string} user 发指令的 QQ 号
 * @returns {Promise<{sessionId: string, type: string, qr: string, expireIn: number}>}
 */
export async function loginStart (type, user = '') {
  const json = await request('/v1/login/start', { type, user })
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

/** 登录成功后把凭证交给网关落库（user 决定存到谁名下，见 loginStart） */
export async function loginCommit (sessionId, user = '') {
  const json = await request('/v1/login/commit', { session: sessionId, user }, { allowEmpty: true })
  return json.data
}
