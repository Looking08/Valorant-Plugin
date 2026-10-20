import http from 'node:http'
import { resolveProvider } from './providers/index.js'
import { createLoginManager } from './login/index.js'
import { listAccounts, readBase, normalizeUser } from './creds.mjs'

/**
 * 战绩网关（零依赖，只用 node:http + 全局 fetch）。
 *
 * 为什么有它：插件不该、也不能直接拿着抓包来的登录态去请求官方接口 ——
 *   1) 那些参数来自别人 App 的私有协议，随时变，写死在插件里就是定时炸弹；
 *   2) 每个机器人主人手里的凭证不一样，公共 token 一旦失效全员失效；
 *   3) 限流、重试、多数据源聚合这些事，也不该压在插件里。
 * 所以把它拆成一个独立小服务：插件 ↔ 网关 之间是**稳定的 REST 契约**，
 * 网关 ↔ 官方/第三方 之间爱怎么对接怎么对接。
 *
 * 环境变量：
 *   PORT     端口，默认 7820
 *   TOKEN    插件访问网关用的令牌（对应插件配置的 gateway.token）
 *   PROVIDER demo | http，默认 demo
 *   CACHE_TTL 缓存秒数，默认 180
 */

const PORT = Number(process.env.PORT) || 7820
const TOKEN = process.env.TOKEN || 'change-me'
const PROVIDER = process.env.PROVIDER || 'demo'
const CACHE_TTL = Number(process.env.CACHE_TTL) || 180

const provider = resolveProvider(PROVIDER)

/**
 * 扫码登录会话管理。
 *
 * 放在网关而不是插件里，是因为「拿着扫码拿到的 cookie 去换业务 token」
 * 这一步跟数据源强耦合 —— 它天然属于 provider。插件只负责出图、轮询、提示。
 * 详见 ./login/README.md。
 */
const loginManager = createLoginManager()

/** 简易 TTL 缓存：key → { expire, value } */
const cache = new Map()

function cached (key, ttl = CACHE_TTL) {
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expire) return { value: hit.value, hit: true }
  return { value: undefined, hit: false }
}

function putCache (key, value, ttl = CACHE_TTL) {
  cache.set(key, { value, expire: Date.now() + ttl * 1000 })
  // 顺手做一次轻量清理，长时间运行不至于一直涨
  if (cache.size > 500) {
    const now = Date.now()
    for (const [k, v] of cache) if (now >= v.expire) cache.delete(k)
  }
}

function json (res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

/** 读请求体（导入凭证要走 POST，HAR 可能几 MB） */
async function readBody (req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`)
      error.code = 'BAD_REQUEST'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function readJsonBody (text) {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.code = 'BAD_REQUEST'
    throw error
  }
}

const ok = (res, data, extra = {}) => json(res, 200, { ok: true, data, provider: provider.name, ...extra })

const fail = (res, status, code, message) =>
  json(res, status, { ok: false, error: { code, message } })

/** 把 provider 抛出的错翻译成契约里的错误码 */
function toFailure (res, error) {
  switch (error?.code) {
    case 'NOT_FOUND': return fail(res, 404, 'NOT_FOUND', error.message)
    case 'NOT_BOUND': return fail(res, 409, 'NOT_BOUND', error.message)
    case 'BAD_REQUEST': return fail(res, 400, 'BAD_REQUEST', error.message)
    case 'PRIVATE': return fail(res, 403, 'PRIVATE', error.message)
    case 'RATE_LIMIT': return fail(res, 429, 'RATE_LIMIT', error.message)
    case 'UPSTREAM_AUTH': return fail(res, 502, 'UPSTREAM_AUTH', error.message)
    case 'NOT_SUPPORTED': return fail(res, 501, 'NOT_SUPPORTED', error.message)
    case 'NOT_CONFIGURED': return fail(res, 501, 'NOT_CONFIGURED', error.message)
    default:
      console.error('[gateway] provider error:', error)
      return fail(res, 502, 'UPSTREAM', error?.message || '上游数据源错误')
  }
}

/** 必须实现的方法名 */
const REQUIRED = ['getAccount', 'getProfile', 'getMatches', 'getMatch', 'getWeapons']

for (const fn of REQUIRED) {
  if (typeof provider[fn] !== 'function') {
    console.error(`[gateway] provider "${provider.name}" 缺少方法 ${fn}，无法启动`)
    process.exit(1)
  }
}

const routes = {
  '/health': async (req, res, params, user) => {
    ok(res, {
      provider: provider.name,
      uptime: Math.round(process.uptime()),
      version: '0.2.0',
      // 让插件知道这个网关支不支持「一人一份登录态」
      multiUser: typeof provider.saveCredential === 'function',
      accounts: typeof provider.saveCredential === 'function' ? listAccounts().length : 0
    }, { cached: false })
  },

  '/v1/account': async (req, res, params, user) => {
    const q = params.get('q') || ''
    // 没带 q 也放行：多账号下「我是谁」由登录态决定，不必再报一遍名字
    const key = `account:${user}:${params.get('region') || ''}:${q}`
    const hit = cached(key, 600)
    if (hit.hit) return ok(res, hit.value, { cached: true })

    const value = await provider.getAccount({ query: q, region: params.get('region') || '', user })
    putCache(key, value, 600)
    ok(res, value, { cached: false })
  },

  '/v1/profile': async (req, res, params, user) => {
    const account = params.get('account') || ''
    const key = `profile:${user}:${params.get('region') || ''}:${account}`
    const hit = cached(key, 300)
    if (hit.hit) return ok(res, hit.value, { cached: true })

    const value = await provider.getProfile({ account, region: params.get('region') || '', user })
    putCache(key, value, 300)
    ok(res, value, { cached: false })
  },

  '/v1/matches': async (req, res, params, user) => {
    const account = params.get('account') || ''
    const query = {
      account,
      region: params.get('region') || '',
      count: Math.min(Number(params.get('count')) || 10, 50),
      mode: params.get('mode') || '',
      map: params.get('map') || '',
      user
    }
    const key = `matches:${user}:${query.region}:${account}:${query.count}:${query.mode}:${query.map}`
    const hit = cached(key, 120)
    if (hit.hit) return ok(res, hit.value, { cached: true })

    const value = await provider.getMatches(query)
    putCache(key, value, 120)
    ok(res, value, { cached: false })
  },

  '/v1/weapons': async (req, res, params, user) => {
    const account = params.get('account') || ''
    const query = {
      account,
      region: params.get('region') || '',
      season: params.get('season') || '',
      count: Math.min(Number(params.get('count')) || 20, 60),
      user
    }
    const key = `weapons:${user}:${query.region}:${account}:${query.season}:${query.count}`
    const hit = cached(key, 600)
    if (hit.hit) return ok(res, hit.value, { cached: true })

    const value = await provider.getWeapons(query)
    putCache(key, value, 600)
    ok(res, value, { cached: false })
  },

  /**
   * 同过场的人。
   *
   * GET  /v1/peers            已收录谁（昵称 + 最近一次同场时间）
   * POST /v1/peers {action:'hide'}         把自己从索引里关掉（可退出）
   * POST /v1/peers {action:'hide', name:x} 指定昵称（主人用）
   */
  '/v1/peers': async (req, res, params, user) => {
    if (typeof provider.getPeers !== 'function') {
      throw Object.assign(new Error(`数据源 ${provider.name} 不支持查同场玩家`), { code: 'NOT_SUPPORTED' })
    }

    if ((req.method || 'GET').toUpperCase() === 'GET') {
      ok(res, await provider.getPeers({ user }), { cached: false })
      return
    }

    const body = readJsonBody(await readBody(req))
    const action = String(body?.action || '')
    if (action !== 'hide') {
      throw Object.assign(new Error('只支持 action=hide'), { code: 'BAD_REQUEST' })
    }
    if (typeof provider.hidePeer !== 'function') {
      throw Object.assign(new Error(`数据源 ${provider.name} 不支持隐藏`), { code: 'NOT_SUPPORTED' })
    }
    const n = provider.hidePeer(user, body?.name || '')
    ok(res, { hidden: n }, { cached: false })
  },

  /* ---------------- 凭证（一人一份登录态） ---------------- */

  /**
   * GET  /v1/creds            谁导入过（不回传 cookie）
   * GET  /v1/creds?user=xxx   顺带看这个人的状态
   * POST /v1/creds            {cookie, scene, sceneDetail} → 验证后落盘
   * POST /v1/creds {action:remove} → 删掉这个人的凭证
   */
  '/v1/creds': async (req, res, params, user) => {
    if (typeof provider.saveCredential !== 'function') {
      throw Object.assign(
        new Error(`数据源 ${provider.name} 不支持按用户导入登录态（一人一份）`),
        { code: 'NOT_SUPPORTED' }
      )
    }

    if (req.method === 'POST') {
      const body = readJsonBody(await readBody(req))
      const target = normalizeUser(body.user || user)
      if (!target) throw Object.assign(new Error('缺少 user'), { code: 'BAD_REQUEST' })

      if (String(body.action || '') === 'remove') {
        return ok(res, provider.removeCredential({ user: target }), { cached: false })
      }

      const saved = await provider.saveCredential({
        user: target,
        cookie: body.cookie,
        scene: body.scene,
        sceneDetail: body.sceneDetail
      })
      console.log(`[gateway] 已导入登录态：user=${target} role=${saved?.role?.name || '未知'}`)
      return ok(res, saved, { cached: false })
    }

    const base = readBase()
    ok(res, {
      users: listAccounts(),
      // 没导入的人会不会借用 base 里那份登录态（单人自用才该是 true）
      shared: base.allowShared === true,
      current: user ? provider.credentialStatus({ user }) : { bound: false }
    }, { cached: false })
  },

  /* ---------------- 扫码登录 ---------------- */

  // 用哪些适配器可用（插件据此提示「微信没配置」而不是让用户扫半天）
  '/v1/login/adapters': async (req, res) => {
    ok(res, { adapters: loginManager.list() }, { cached: false })
  },

  '/v1/login/start': async (req, res, params) => {
    const type = params.get('type') || 'qq'
    // user 决定登录成功后凭证落在谁名下，别漏
    const data = await loginManager.start(type, params.get('user') || '')
    ok(res, data, { cached: false })
  },

  '/v1/login/poll': async (req, res, params) => {
    const session = params.get('session') || ''
    const data = await loginManager.poll(session)
    ok(res, data, { cached: false })
  },

  '/v1/login/cancel': async (req, res, params) => {
    const session = params.get('session') || ''
    const data = loginManager.cancel(session)
    if (!data) return fail(res, 404, 'NOT_FOUND', '扫码会话不存在或已过期')
    ok(res, data, { cached: false })
  },

  // 登录成功后把凭证交给 provider 落库（provider 没实现 saveLogin 就如实说明）
  '/v1/login/commit': async (req, res, params) => {
    const session = params.get('session') || ''
    const data = await loginManager.commit(session, provider)
    if (!data) return fail(res, 404, 'NOT_FOUND', '会话不存在，或还没确认登录')
    ok(res, data, { cached: false })
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' })
    return res.end()
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const params = url.searchParams

  // 令牌校验：TOKEN 为空时网关完全开放（仅限本机调试，别公网裸奔）
  if (TOKEN && url.pathname !== '/health') {
    const auth = String(req.headers.authorization || '')
    if (auth !== `Bearer ${TOKEN}`) return fail(res, 401, 'AUTH', '令牌不正确')
  }

  /**
   * 谁在查。插件会把发指令的 QQ 号放在 `user` 参数里，网关据此挑登录态。
   * 没有就落到 mate.json 自己那份（CLI / 探针 / 单人自用）。
   */
  let user = ''
  try {
    user = normalizeUser(params.get('user') || req.headers['x-user'] || '')
  } catch (error) {
    return fail(res, 400, 'BAD_REQUEST', error.message)
  }

  try {
    // /v1/match/<id>
    const match = url.pathname.match(/^\/v1\/match\/([^/]+)$/)
    if (match) {
      const matchId = decodeURIComponent(match[1])
      const key = `match:${user}:${matchId}:${params.get('account') || ''}`
      const hit = cached(key, 3600)
      if (hit.hit) return ok(res, hit.value, { cached: true })

      const value = await provider.getMatch({
        matchId,
        account: params.get('account') || '',
        user
      })
      putCache(key, value, 3600)
      return ok(res, value, { cached: false })
    }

    const route = routes[url.pathname]
    if (!route) return fail(res, 404, 'BAD_REQUEST', `未知路由：${url.pathname}`)

    await route(req, res, params, user)
  } catch (error) {
    toFailure(res, error)
  }
})

/**
 * 登录态保温。
 *
 * 为什么要这个：掌瓦那份凭证里的 access_token 有效期只有 3600 秒，
 * 而 `/go/auth/refresh_third_token` 只用 `type + uuid + openid`
 * 就能换到新的（不需要 App 签名）—— 只要在票据彻底过期前一直续，
 * 就不用再让人重新抓包。
 *
 * 懒加载式续期（发请求时才续）不够：安静挂两周照样凉。
 * 这里给它按 25 分钟一次主动续。KEEP_ALIVE=0 可以关掉。
 */
function startKeepAlive () {
  if (process.env.KEEP_ALIVE === '0') return
  if (typeof provider.touchCredential !== 'function') return

  const targets = () => {
    const users = typeof provider.saveCredential === 'function' ? listAccounts() : []
    return [''].concat(users.map(a => a.user))
  }

  const run = async () => {
    let ok = 0
    let bad = 0
    for (const user of targets()) {
      try {
        if (await provider.touchCredential(user)) ok += 1
        else bad += 1
      } catch {
        bad += 1
      }
      await new Promise(r => setTimeout(r, 800))
    }
    if (ok || bad) {
      console.log(`[gateway] 登录态保温：续期成功 ${ok} 份${bad ? `，失败 ${bad} 份（票据可能已过期，需要重新抓包）` : ''}`)
    }
  }

  run()
  setInterval(run, 25 * 60 * 1000).unref?.()
}

server.listen(PORT, () => {
  console.log('------------------------------------------')
  console.log(`无畏契约战绩网关已启动`)
  console.log(`  监听：http://127.0.0.1:${PORT}`)
  console.log(`  数据源 provider：${provider.name}`)
  if (typeof provider.saveCredential === 'function') {
    const count = listAccounts().length
    console.log(`  多账号：已开启（已导入 ${count} 份登录态）`)
  }
  if (typeof provider.touchCredential === 'function' && process.env.KEEP_ALIVE !== '0') {
    console.log('  登录态保温：已开启（每 25 分钟续一次 access_token，KEEP_ALIVE=0 关闭）')
  }
  console.log(`  扫码适配器：${loginManager.list().join(' / ') || '无'}`)
  console.log(`  令牌：${TOKEN === 'change-me' ? 'change-me（请务必改成自己的）' : '已自定义'}`)
  console.log('------------------------------------------')

  startKeepAlive()
})
