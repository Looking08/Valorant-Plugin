/**
 * 掌瓦（掌上无畏契约 App）数据源 —— 按真实抓包写实。
 *
 * ## 这套接口长什么样
 *
 *   POST https://app.mval.qq.com/go/codev/career/<接口>?source_game_zone=codev&game_zone=codev
 *   Cookie: clientType=9; appid=...; openid=...; access_token=...; userId=...; ...
 *   Body:   { "scene": "v3_...", ... }
 *
 * 三个「不按常理」的地方，踩过一次就够了：
 *
 *   1. **`result` 是字符串 `"0"`，不是数字 0**。用 `=== 0` 判会全军覆没。
 *   2. **`scene` 是会话级 blob**，不是 token。同一份 scene 能重放几十次，
 *      但它跟「哪一页」有关：战绩列表/概览用一个（约 175 字符），
 *      单局详情（回合、回合总览）用另一个（约 91 字符）。所以配置里分成
 *      `scene` / `sceneDetail` 两个。
 *   3. **接口之间靠 id 串**：`record/list` 给 `battle_id` + `game_mode_id` + `game_submode_id`，
 *      查详情要把这三个一起回传（`scoreboard` 用 game_mode_id 当 queue_id，
 *      `player/rounds` 用 game_submode_id 当 game_mode）。所以下面有个内存缓存
 *      记住「列表里见过的对局」，详情页就不用你手动传这些参数。
 *
 * ## 字段口径（跟插件侧的差异，改之前先看）
 *
 *   掌瓦给的是「游戏内自研指标」，跟 Riot 官方 API 不是一套：
 *     · `score`        = ACS（平均战斗得分），不是比分。列表里**没有比分**，
 *                        只有详情页 `winning_games/failed_games` 能算出 13-11。
 *     · `kill_head`    = 精准击败**率**（`22.0` 就是 22%），不是爆头击杀数。
 *     · `kda_score`    = KDA（(击杀+助攻)/死亡）。
 *     · `part`         = 该特工的**场次**（拿 27 场 × 20 分钟 ≈ 9 小时，
 *                        跟 `time` 字段对得上，不是百分比）。
 *     · 没有 KAST、没有总命中数、没有单局时长（只有 `36m25s` 这种字符串）。
 *
 * ## 怎么用
 *
 *   1. cp bridge/providers/mateapp.example.json bridge/mate.json
 *   2. 按 ./mateapp.md 抓包，把 cookie / scene / role.uid 填进 mate.json
 *   3. node bridge/providers/mateapp-cli.mjs        ← 逐条验活，打印原始字段
 *   4. PROVIDER=mateapp node bridge/server.mjs
 *
 * ## 一个设计取舍
 *
 * 掌瓦的接口**认 cookie 里的 openid，不认 "名称#标签"**。所以这里不做
 * 「按名字搜人」，而是绑定配置里那一个角色 —— 插件侧 `#瓦绑定` 依然能用，
 * 只是校验会显示「未校验」，这是正常的。
 */
import {
  resolveConfig,
  readBase,
  readOverlay,
  saveAccount,
  removeAccount,
  normalizeUser,
  CONFIG_PATH
} from '../creds.mjs'

const TIMEOUT = Number(process.env.MATE_TIMEOUT) || 20000

/** 单次 `#瓦战绩` 最多翻几页（一页 10 条，掌瓦只保留最近 60 天/100 场） */
const MAX_PAGES = 6

/* ---------------- 凭证小工具 ---------------- */

/** 把「Cookie: xxx」整行、换行、首尾引号都清掉，只留 `k=v; k=v` */
function normalizeCookie (raw) {
  let text = String(raw || '').trim()
  text = text.replace(/^cookie\s*:\s*/i, '')
  text = text.replace(/^["'`]|["'`]$/g, '')
  // 折行的 cookie（抓到的是多行）拼回去
  text = text.replace(/\r?\n\s*/g, ' ')
  return text.replace(/\s*;\s*/g, '; ').trim()
}

/** 从 cookie 里取一个键（`userId=JA-xxx`） */
function cookieValue (cookie, name) {
  const m = String(cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'i'))
  return m ? decodeURIComponent(m[1].trim()) : ''
}

/**
 * 用刚导入的登录态认出「这是谁」。
 *
 * 掌瓦没有任何「我是谁」的接口，但记分板里的 `scoreboard[]` 会带
 * `is_me: "1"` 的那一条，里面有 `user_name` 和 `role_id`。
 * 所以：先拉一页列表 → 取最近一局 → 查记分板 → 找 is_me。
 */
async function discoverRole (user) {
  const config = readConfig(user)
  const list = await callEndpoint('matches', { baton: '' }, config)
  const first = list?.battle_list?.[0]
  if (!first?.battle_id) return null

  const board = await callEndpoint('match', {
    battleId: String(first.battle_id),
    queueId: String(first.game_mode_id || config.defaults?.queueId || '255')
  }, config)

  // 注意层级：callEndpoint 已经把信封里的 data 拆出来了，
  // 记分板接口的 data 本身就是 `{detail, scoreboard}`，没有再多一层 board。
  const rows = board?.scoreboard || board?.board?.scoreboard || []
  const self = rows.find(p => String(p.is_me) === '1')
  if (!self) return null

  return { name: self.user_name || '', roleId: String(self.role_id || '') }
}

/* ---------------- 配置（多账号：按 user 深合并 base + 覆盖层） ---------------- */

/**
 * 取这次请求该用的配置。
 *
 * `user` 为空 → mate.json 自己那份（CLI 探针、健康检查）；
 * `user` 有值 → 该用户导入的凭证叠加在 mate.json 之上。
 * 没有导入过就抛 NOT_BOUND，**不会**退回去用别人的登录态。
 */
export function readConfig (user) {
  return resolveConfig(user)
}

/** 配置里那个「机器人主人自己的」角色，给 CLI / 无 user 场景用 */
export function baseConfig () {
  return readBase()
}

/* ---------------- 请求 ---------------- */

/** 把 `{uid}` 这类占位符换成实际值 */
function fill (value, vars) {
  if (typeof value !== 'string') return value
  return value.replace(/\{(\w+)\}/g, (all, key) => (key in vars ? String(vars[key]) : all))
}

/**
 * 占位符取值表。
 *
 * `seasonId` / `queueId` 不写死：`career/seasonoverview` 的 `season_list` 会给出
 * 当前赛季的 key（序幕八 = "8"），运行时自己推出来，换赛季不用改配置。
 */
function varsOf (config, extra = {}) {
  const role = config.role || {}
  const login = config.login || {}
  const defaults = config.defaults || {}
  return {
    uid: role.uid || '',
    roleId: role.roleId || role.uid || '',
    uuid: role.uuid || '',
    openid: login.openid || '',
    zone: role.zone || 'codev',
    account: role.uid || '',
    scene: login.scene || '',
    sceneDetail: login.sceneDetail || login.scene || '',
    seasonId: defaults.seasonId || seasonOf(config?.__user) || '255',
    queueId: defaults.queueId || '255',
    gameMode: defaults.gameMode || '101001',
    season: '',
    mode: '255',
    baton: '',
    modeFilter: '',
    battleId: '',
    roundNum: 0,
    page: 1,
    count: 10,
    ...extra
  }
}

function upstreamError (message, code = 'UPSTREAM') {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 服务端有时候会把错误响应体**连着拼两遍**（`{...}{...`），JSON.parse 直接挂。
 * 这里先老实 parse，失败就退到「取第一个平衡的 JSON 对象」。
 */
function parseLoose (text) {
  try {
    return JSON.parse(text)
  } catch {}
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"') { quote = '"'; continue }
    if (ch === '{') depth += 1
    else if (ch === '}' && depth > 0) {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(text.slice(0, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 把 cookie 里某个字段换成新值，其余原样保留 */
function patchCookie (cookie, key, value) {
  return String(cookie).split(';')
    .map(part => {
      const name = part.trim().split('=')[0]
      return name === key ? `${key}=${value.trim()}` : part.trim()
    })
    .filter(Boolean)
    .join('; ')
}

/**
 * 从 cookie 里反推「我是谁」。
 *
 * `refresh_third_token` 只要 `type + uuid + openid` 三个值，而这三个值
 * 全都能从登录态自己的 cookie 里读出来 —— 不需要额外让用户再抓一遍。
 */
function loginIdentity (cookie) {
  const appid = cookieValue(cookie, 'appid') || ''
  const acctype = cookieValue(cookie, 'acctype') || ''
  const openid = cookieValue(cookie, 'openid') || ''
  const uuid = cookieValue(cookie, 'userId') || cookieValue(cookie, 'uuid') || ''
  // appid=wxcbb49f1f... 是微信；抓包里同时看到 accountType=2 对应微信，留着兜底
  const type = appid.startsWith('wx') ? 'wx' : acctype === '2' ? 'wx' : 'qq'
  return { type, openid, uuid, ready: Boolean(openid && uuid) }
}

/**
 * 用现有登录态换一个新的第三方 access_token。
 *
 * 实测结论（2026-10 在本机拿真实登录态打过）：
 * `/go/auth/refresh_third_token` 光凭 `type + uuid + openid` 就肯签发新 token，
 * **不需要 ct，也不需要 App 端的任何签名** —— 签名只在 App 内部那一步需要，
 * 这一步服务端认的是 cookie 里还在有效期内的登录票据。
 * 换出来的新 token 配上原来的 scene 一样查得动数据，等于给登录态续命。
 *
 * 票据彻底过期后它会返回 result 非 0 + 「登录态失效，请重新登录」，
 * 那时候才是真的要重新抓包。拿不到新 token 就返回 null，调用方保持原样。
 */
export async function refreshAccessToken (config) {
  const cookie = config.login?.cookie
  const id = loginIdentity(cookie)
  if (!cookie || !id.ready) return null

  const url = new URL('/go/auth/refresh_third_token', config.baseUrl)
  url.searchParams.set('source_game_zone', 'codev')
  url.searchParams.set('game_zone', 'codev')

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        Cookie: cookie
      },
      body: JSON.stringify({
        type: id.type,
        uuid: id.uuid,
        openid: id.openid,
        source_game_zone: 'codev',
        game_zone: 'codev'
      }),
      signal: AbortSignal.timeout(TIMEOUT)
    })
  } catch {
    return null
  }

  const json = parseLoose(await res.text().catch(() => ''))
  const token = json?.data?.access_token
  if (!token) return null
  return patchCookie(cookie, 'access_token', token)
}

/**
 * 给某个用户（不传则给 mate.json 那份）的登录态续一次 token。
 *
 * 网关的后台保温任务用这个：懒加载式续期只在「有人查」的时候生效，
 * 安静待两周还是会凉。这里可以直接按账号调用。
 */
export async function touchCredential (user) {
  try {
    const cfg = readConfig(user)
    if (!cfg?.login?.cookie || cfg.login?.refreshToken === false) return false
    const next = await refreshAccessToken(cfg)
    if (!next) return false
    tokenState.set(cfg.__user || '__base', { cookie: next, at: Date.now() })
    return true
  } catch {
    return false
  }
}

// token 官方给 3600 秒，这里留一半余量就去续
const TOKEN_TTL = 30 * 60 * 1000
const tokenState = new Map()
const tokenFlights = new Map()

/**
 * 拿一个「尽量新鲜」的 cookie 去发请求。
 *
 * 任何一步出问题都原样退回到原来那份 cookie —— 宁可续不上，
 * 也绝不把现在还能用的登录态改坏。
 */
async function freshCookie (config) {
  const key = config.__user || '__base'
  const cookie = config.login?.cookie
  if (!cookie || config.login?.refreshToken === false) return cookie

  const cached = tokenState.get(key)
  if (cached && Date.now() - cached.at < TOKEN_TTL) return cached.cookie

  let flight = tokenFlights.get(key)
  if (!flight) {
    flight = refreshAccessToken(config).catch(() => null)
    tokenFlights.set(key, flight)
  }
  let next = null
  try {
    next = await flight
  } finally {
    tokenFlights.delete(key)
  }
  if (next) tokenState.set(key, { cookie: next, at: Date.now() })
  return next || tokenState.get(key)?.cookie || cookie
}

function headersOf (config, cookie) {
  const login = config.login || {}
  const headers = { Accept: 'application/json', ...(login.headers || {}) }
  // 允许只写一行 cookie，比手写 headers 对象省事（也少一个漏引号的机会）
  const value = cookie ?? login.cookie
  if (value && !headers.Cookie && !headers.cookie) headers.Cookie = value
  return headers
}

/**
 * 按端点配置发一次请求，拆掉业务信封后返回 data。
 *
 * 腾讯这套接口的信封是 `{ result, msg, err_msg, req_id, data }`，
 * `result` 是**字符串** "0" 才表示成功 —— 注意跟 Riot 那套 `{status}` 完全不同。
 * 用 `config.envelope` 可以改（okValues 支持多个可接受值）。
 */
export async function callEndpoint (name, extra = {}, preset = null) {
  // preset 传了就用它（provider 内部已经解析过一次，别重复读文件）；
  // 没传就按 extra.user 现解析 —— CLI / 探针走的就是这条路。
  const config = preset || readConfig(extra.user)
  const spec = config.endpoints?.[name]

  if (!spec?.path) {
    throw upstreamError(
      `mate.json 里没配 endpoints.${name}。抓包时把这条请求的路径填进去。`,
      'NOT_CONFIGURED'
    )
  }
  if (!config.baseUrl) {
    throw upstreamError('mate.json 里没配 baseUrl', 'NOT_CONFIGURED')
  }

  // 每次真正发请求前先看能不能把 access_token 续一下（拿不到就用原样那份）
  const headers = headersOf(config, await freshCookie(config))
  if (!Object.keys(headers).some(k => /^(cookie|authorization|x-token|access_token)$/i.test(k))) {
    throw upstreamError(
      'mate.json 里没配 login.cookie（或 login.headers）。掌瓦的接口靠 cookie 认人，'
      + '抓包时把整条请求的 Cookie 抄过来。',
      'NOT_CONFIGURED'
    )
  }

  const vars = varsOf(config, extra)
  const url = new URL(fill(spec.path, vars).replace(/^\/?/, '/'), config.baseUrl)

  for (const [key, value] of Object.entries(spec.query || {})) {
    url.searchParams.set(key, fill(String(value), vars))
  }

  const method = (spec.method || 'GET').toUpperCase()
  const init = { method, headers, signal: AbortSignal.timeout(TIMEOUT) }

  if (method !== 'GET' && spec.body) {
    if (spec.bodyType === 'form') {
      const form = new URLSearchParams()
      for (const [key, value] of Object.entries(spec.body)) form.set(key, fill(String(value), vars))
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      init.body = form.toString()
    } else {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      init.body = JSON.stringify(
        Object.fromEntries(Object.entries(spec.body).map(([k, v]) => [k, fill(v, vars)]))
      )
    }
  }

  let res
  try {
    res = await fetch(url, init)
  } catch (error) {
    const reason = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? '请求超时'
      : error.message
    throw upstreamError(`连不上掌瓦接口（${reason}）`)
  }

  // 先读 body 再看状态码：接口出错时它往往给 200 + {result: 非0}，
  // 只盯着状态码会把「登录态失效」看成「一切正常」。
  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    if (res.status === 401 || res.status === 403) {
      throw upstreamError('掌瓦返回 401/403，登录态失效了，重新抓一次包', 'UPSTREAM_AUTH')
    }
    throw upstreamError(
      `掌瓦返回的不是 JSON（HTTP ${res.status}，开头：${text.slice(0, 80) || '空'}）。`
      + '多半是 Cookie / scene 过期，或者 endpoints 路径填错了。'
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw upstreamError('掌瓦返回 401/403，登录态失效了，重新抓一次包', 'UPSTREAM_AUTH')
  }

  const envelope = {
    okField: 'result',
    okValues: [0, '0'],
    dataField: 'data',
    msgField: 'msg',
    ...(config.envelope || {})
  }
  // 兼容只写了 okValue 的旧配置，也兼容写成数组的新配置
  const accepted = (envelope.okValues || [envelope.okValue ?? 0]).map(String)

  const raw = json?.[envelope.okField]
  if (!accepted.includes(String(raw))) {
    const msg = String(json?.[envelope.msgField] || json?.err_msg || '没有说明原因').trim()
    const authish = /登录|login|token|凭证|鉴权|expired|auth|scene/i.test(msg)
    throw upstreamError(
      `掌瓦接口返回失败（${envelope.okField}=${raw === undefined ? '缺失' : raw}）：${msg || '没有说明原因'}`,
      authish ? 'UPSTREAM_AUTH' : 'NOT_FOUND'
    )
  }

  return envelope.dataField ? json[envelope.dataField] : json
}

/* ---------------- 运行时状态（赛季 / 见过的对局） ---------------- */

/**
 * 当前赛季 key：从 seasonoverview 的 season_list 推，换赛季自动跟进。
 *
 * ⚠️ 必须按用户分开存：不同账号可能停留在不同赛季（回归号 vs 活跃号），
 *    共用一份会让 A 的赛季号带进 B 的请求里，轻则查空、重则查成别人的数据。
 */
const seasonState = new Map()

function rememberSeason (overview, user) {
  const keys = (overview?.season_list || [])
    .map(x => String(x?.key ?? ''))
    .filter(k => k && k !== '255')
  if (!keys.length) return

  const numeric = keys.map(Number).filter(n => Number.isFinite(n))
  const value = numeric.length ? String(Math.max(...numeric)) : keys[keys.length - 1]
  seasonState.set(String(user || ''), { value, at: Date.now() })
}

function seasonOf (user) {
  const hit = seasonState.get(String(user || ''))
  return hit && Date.now() - hit.at < 30 * 60 * 1000 ? hit.value : ''
}

async function ensureSeason (config) {
  if (config?.defaults?.seasonId) return
  const user = config?.__user || ''
  if (seasonOf(user)) return
  try {
    rememberSeason(await callEndpoint('profile', {}, config), user)
  } catch {
    // 拿不到就退回 255（生涯），别让整次查询因为「赛季号不知道」而失败
  }
}

/**
 * 见过的对局：`<user>:<battle_id>` → 列表里的那一条。
 * 详情页需要它带 game_mode_id / game_submode_id，否则接口会返回空记分板。
 */
const battleState = new Map()
const BATTLE_TTL = 30 * 60 * 1000

function rememberBattles (rows = [], user = '') {
  const now = Date.now()
  const scope = String(user || '')
  for (const row of rows) {
    const id = String(row?.battle_id || row?.match_id || '')
    if (id) battleState.set(`${scope}:${id}`, { item: row, at: now })
  }
  // 顺手清掉过期条目，免得长期跑着的机器人越攒越多
  if (battleState.size > 200) {
    for (const [id, hit] of battleState) {
      if (now - hit.at > BATTLE_TTL) battleState.delete(id)
    }
  }
}

function battleMetaOf (matchId, user = '') {
  const hit = battleState.get(`${String(user || '')}:${String(matchId)}`)
  return hit && Date.now() - hit.at < BATTLE_TTL ? hit.item : null
}

/* ---------------- 记分板缓存（列表算 MVP 与详情页共用一份） ---------------- */

/**
 * 为什么要缓存这一层：
 *
 * 掌瓦的**列表接口不告诉你「这局是不是 MVP」**（`rank` 恒为 0），只有
 * 记分板接口的 `detail.rank` 才有 —— 它正好等于「十个人按 ACS 排序后的名次」
 * （实测 10/10 局一致，rank=1 就是全场最佳）。
 *
 * 所以列表想标 MVP 就得多打一次记分板。既然打了就把它存下来：
 * 用户点进详情时直接命中，不会重复请求。TTL 30 分钟。
 */
const boardState = new Map()
const BOARD_TTL = 30 * 60 * 1000

function boardOf (config, battleId, extra = {}) {
  const id = String(battleId)
  // 记分板也是「谁的登录态开出来的」，缓存必须带上用户，否则 A 会命中 B 的牌面
  const key = `${config?.__user || ''}:${id}`
  const hit = boardState.get(key)
  if (hit && Date.now() - hit.at < BOARD_TTL) return Promise.resolve(hit.board)

  return callEndpoint('match', { battleId: id, ...extra }, config).then(board => {
    boardState.set(key, { board, at: Date.now() })

    if (boardState.size > 200) {
      const now = Date.now()
      for (const [k, item] of boardState) {
        if (now - item.at > BOARD_TTL) boardState.delete(k)
      }
    }
    return board
  })
}

/** 极简并发池：同样的请求量，串行要 2 秒，限流并发只要 400ms */
async function pool (tasks, limit = 4) {
  const results = new Array(tasks.length).fill(null)
  let cursor = 0

  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await tasks[index]()
      } catch {
        results[index] = null
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

/**
 * 给列表的每一行补上「本局名次」。
 *
 * 查不到（对局太老、模式不支持、上游抽风）就把 rank 留空 ——
 * 界面上不显示，绝不猜一个「大概第几」出来。
 */
async function attachRanks (list, rows, config) {
  const setting = config.mvp || {}
  if (setting.lookup === false) return

  const limit = Math.min(Math.max(Number(setting.limit) || 20, 1), list.length)
  const concurrency = Math.min(Math.max(Number(setting.concurrency) || 4, 1), 8)

  const tasks = list.slice(0, limit).map((item, i) => async () => {
    const row = rows[i] || {}
    const board = await boardOf(config, item.matchId, {
      queueId: String(row.game_mode_id || config.defaults?.queueId || '255'),
      gameMode: String(row.game_submode_id || config.defaults?.gameMode || '101001')
    })
    const rank = num(board?.detail?.rank)
    return rank > 0 ? rank : null
  })

  const ranks = await pool(tasks, concurrency)
  ranks.forEach((rank, i) => {
    if (i >= limit) return
    list[i].rankInMatch = rank
    list[i].mvp = rank === 1
  })
}

/* ---------------- provider ---------------- */

export const mateappProvider = {
  name: 'mateapp',

  // 给网关的后台保温用：见 server.mjs 的 startKeepAlive()
  touchCredential,

  /**
   * 掌瓦不提供「按名字找人」，只认已登录角色的 uid。
   * 这里只做一件事：确认你传的账号跟配置里的角色是同一个，避免查错人。
   */
  async getAccount ({ query, user }) {
    const config = readConfig(user)
    const role = config.role || {}
    if (!role.uid) {
      throw upstreamError('mate.json 里没配 role.uid，抓包里 cookie 的 userId / uuid 填进去', 'NOT_CONFIGURED')
    }

    const name = String(query || '').split('#')[0].trim()
    // 多账号下「查别人」依然做不到 —— 但这里只在同一个人的登录态里比对，
    // 所以 A 查 B 会得到「你只能查自己」，而不是看到 A 的数据冒充 B。
    const allowMismatch = config.strictRole === false
    if (name && role.name && name !== role.name && !allowMismatch) {
      throw upstreamError(
        `这个数据源只服务当前登录的那个角色（${role.name}），查不了「${name}」。`
        + '想看别人的数据，得让对方自己发 #瓦登录 导入他自己的登录态。',
        'NOT_SUPPORTED'
      )
    }

    const display = role.name || role.uid
    return {
      puuid: role.uid,
      // 国服掌瓦没有 #tag，硬拼一个 "名字#" 很难看，也让人以为要带标签查
      id: role.tag ? `${display}#${role.tag}` : display,
      name: display,
      tag: role.tag || '',
      region: role.zone || 'cn',
      accountLevel: 0,
      title: '掌瓦已登录角色',
      card: { small: '', large: '', wide: '' }
    }
  },

  /**
   * 面板要拼四条接口：赛季总览（段位/胜率）、我的数据（ACS/KDA/命中）、
   * 特工表现、地图表现。后两条失败不影响主面板，降级成空数组。
   */
  async getProfile ({ account, user }) {
    const config = readConfig(user)

    const overview = await callEndpoint('profile', {}, config)
    rememberSeason(overview, user)
    await ensureSeason(config)

    const [stat, agents, maps, recent] = await Promise.all([
      callEndpoint('stat', {}, config).catch(() => null),
      callEndpoint('agents', {}, config).catch(() => null),
      callEndpoint('maps', {}, config).catch(() => null),
      callEndpoint('recent', {}, config).catch(() => null)
    ])

    if (recent?.battle_list) rememberBattles(recent.battle_list, user)

    return MAPPING.profile({ overview, stat, agents, maps, recent }, ctxOf(account, user))
  },

  /**
   * 战绩列表。掌瓦只留最近 60 天/100 场，一页 10 条，用 `baton` 往后翻。
   *
   * 列表本身不带 MVP（`rank` 恒为 0），所以额外的记分板查询在这里补 ——
   * 配置 `mvp.lookup: false` 可以关掉，关掉后列表只剩上游给的 D/A/SS 评价等级。
   */
  async getMatches ({ account, count, user }) {
    const want = Math.min(Math.max(Number(count) || 10, 1), 50)
    const config = readConfig(user)

    const first = await callEndpoint('matches', { baton: '' }, config)
    const rows = [...(first?.battle_list || [])]
    let baton = first?.next_baton || ''
    let guard = 0

    while (rows.length < want && baton && guard < MAX_PAGES) {
      guard += 1
      const next = await callEndpoint('matches', { baton }, config)
      const more = next?.battle_list || []
      if (!more.length) break
      rows.push(...more)
      baton = next?.next_baton || ''
    }

    rememberBattles(rows, user)

    const sliced = rows.slice(0, want)
    const mapped = MAPPING.matches({ ...first, battle_list: sliced }, ctxOf(account, user))

    // 补「本局全场第几」。写在映射之后：映射只管字段，命名次是另一件事。
    await attachRanks(mapped.list, sliced, config)

    return mapped
  },

  /**
   * 单局详情：记分板 + 逐回合。
   *
   * 两个接口用的参数不一样（还用了另一个 scene），都从缓存里的列表条目取：
   *   scoreboard    ← battle_id + queue_id = game_mode_id ("101")
   *   player/rounds ← battle_id + game_mode = game_submode_id ("101001")
   */
  async getMatch ({ matchId, account, user }) {
    const id = String(matchId || '')
    if (!id) throw upstreamError('查详情需要 battle_id', 'NOT_CONFIGURED')

    const config = readConfig(user)

    let meta = battleMetaOf(id, user)
    if (!meta) {
      // 没在本进程里列过这局：翻一页列表碰运气（列表就是最近 10 场）
      const first = await callEndpoint('matches', { baton: '' }, config).catch(() => null)
      rememberBattles(first?.battle_list || [], user)
      meta = battleMetaOf(id, user)
    }

    const queueId = String(meta?.game_mode_id || '')
    const gameMode = String(meta?.game_submode_id || '')
    const extra = {
      battleId: id,
      queueId: queueId || config.defaults?.queueId || '255',
      gameMode: gameMode || config.defaults?.gameMode || '101001'
    }

    const [board, rounds] = await Promise.all([
      boardOf(config, id, extra),
      callEndpoint('matchRounds', extra, config).catch(() => null)
    ])

    // 万象地带（斗牛/团队激战）这类模式，详情里的 used_map 是空的 ——
    // 用列表那条 content 里的地图名兜底，总比显示「未知地图」强
    const hint = splitContent(meta?.content)

    return MAPPING.match(
      { board, rounds, battleId: id, mapHint: hint.map, modeHint: hint.mode },
      ctxOf(account, user)
    )
  },

  /** 枪械熟练度：performance/gun 只给击杀/精准击败率/每回合击杀/最远击杀 */
  async getWeapons ({ account, user }) {
    const config = readConfig(user)
    await ensureSeason(config)
    const raw = await callEndpoint('weapons', {}, config)
    return MAPPING.weapons(raw, ctxOf(account, user), config)
  },

  /**
   * 导入一份登录态（多账号的入口）。
   *
   * 掌瓦没有可复现的扫码流程（详见 mateapp.md「为什么不能扫码」），
   * 所以「登录」在这里的语义就是「把你抓包得到的三样东西交给我」：
   * `login.cookie` + `scene` + `sceneDetail`。
   *
   * 收下之后立刻用它打一次真实请求做验证，顺便把角色名 / role_id 认出来 ——
   * 不验证就存，用户会在下一次查询时才发现凭证是坏的，排错成本高得多。
   */
  async saveCredential ({ user, cookie, scene, sceneDetail }) {
    const key = String(user || '').trim()
    if (!key) throw upstreamError('保存凭证需要 user', 'BAD_REQUEST')

    const cleanCookie = normalizeCookie(cookie)
    if (!cleanCookie) {
      throw upstreamError(
        'cookie 是空的。掌瓦靠 cookie 认人，至少要带 access_token / openid / userId 这几段。',
        'BAD_REQUEST'
      )
    }

    /**
     * scene 必须随凭证一起导入，不能用 base 里的兜底。
     *
     * 因为 base 里那份 scene 属于**部署者本人**：拿别人的 scene 配自己的 cookie，
     * 轻则查不出来，重则把部署者的数据当成你的返回 —— 多账号最怕这种串号。
     */
    const cleanScene = String(scene || '').trim()
    if (!cleanScene) {
      throw upstreamError(
        '还差 scene。掌瓦每次请求都要在 body 里带 scene（v3_ 开头那一串），'
        + '它跟账号绑定，不能借用别人的。抓包里 career/record/list 那条请求的 body 里就有。',
        'BAD_REQUEST'
      )
    }

    const uid = cookieValue(cleanCookie, 'userId')
    const role = { uid }

    // 先落盘再做验证：验证要读配置，而读配置需要覆盖层已经存在。
    // 验证失败会把刚写的文件删掉，不会留下半份坏凭证。
    saveAccount(key, { cookie: cleanCookie, scene: cleanScene, sceneDetail, role })

    try {
      const found = await discoverRole(key)
      if (found?.name || found?.roleId) {
        saveAccount(key, {
          cookie: cleanCookie,
          scene: cleanScene,
          sceneDetail,
          role: { ...role, name: found.name || '', roleId: found.roleId || '' }
        })
      }
      return {
        user: key,
        role: { uid, name: found?.name || '', roleId: found?.roleId || '' },
        verified: true
      }
    } catch (error) {
      removeAccount(key)
      throw upstreamError(
        `登录态验证失败：${error.message}\n`
        + '多半是 cookie / scene 抄漏了，或者抓包时登录态已经过期 —— 重新抓一次。',
        error.code || 'UPSTREAM_AUTH'
      )
    }
  },

  /** 这个用户导入过没有、还能不能用 */
  credentialStatus ({ user }) {
    const key = normalizeUser(user)
    if (!key) return { bound: false }
    const overlay = readOverlay(key)
    if (!overlay) return { bound: false }
    return {
      bound: true,
      usable: !!(overlay.login?.cookie && (overlay.login?.scene || readBase()?.login?.scene)),
      role: overlay.role || {},
      updatedAt: overlay.updatedAt || ''
    }
  },

  /** 解除某个用户的凭证 */
  removeCredential ({ user }) {
    return { removed: removeAccount(user) }
  },

  /**
   * 扫码登录对掌瓦无效，这里**实现出来只是为了把话说清楚**。
   *
   * 返回 `saved: false` 会覆盖 session.commit 里的 `saved: true`，
   * 所以插件不会误报「登录成功」—— 不然用户会以为下次就能查了。
   */
  async saveLogin () {
    return {
      saved: false,
      hint: '掌瓦没有可用的扫码登录通道（登录态由 App 内部签名，服务端复现不了）。'
        + '请用 #瓦登录 导入抓到的登录态。'
    }
  }
}

function ctxOf (account, user) {
  const config = readConfig(user)
  const role = config.role || {}
  return {
    account: account || role.uid || '',
    role,
    name: role.name || '',
    tag: role.tag || '',
    zone: role.zone || 'cn'
  }
}

/* ============================================================
 *  下面的字段路径全部来自实测抓包（2026-10-17 的掌瓦 2.9.0）。
 *  上游改了结构的话，跑 `node bridge/providers/mateapp-cli.mjs`
 *  看原始 JSON，照着改 —— 所有取值都走 pick()，换成正确路径即可。
 * ============================================================ */

/** 安全取深路径：pick(obj, 'data.list') 取不到就返回 undefined */
function pick (obj, path) {
  return String(path).split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj)
}

/** 多路径取第一个有值的 */
function pickAny (obj, paths, fallback) {
  for (const p of paths) {
    const value = pick(obj, p)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return fallback
}

/** 转数字，失败给兜底（缺字段时页面显示 0 比显示 NaN 体面） */
function num (value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 掌瓦的百分比有三种写法：`'62.5%'`、`'62.1'`、`'18%'`，统一成 0~1 小数。
 * 注意 `pct()`（另一种口径，0~100）别混用 —— 插件侧的 `pct01()` 要的是小数。
 */
function rate (value) {
  if (value === null || value === undefined || value === '') return 0
  const text = String(value).trim()
  const hasSign = text.includes('%')
  const n = Number(text.replace('%', ''))
  if (!Number.isFinite(n)) return 0
  return hasSign || n > 1 ? Math.round((n / 100) * 10000) / 10000 : n
}

/** `'36m25s'` → 2185（秒）。单位不固定，按 时/分/秒 一起抠 */
function seconds (text) {
  const s = String(text || '')
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(num(s))
  let total = 0
  const h = s.match(/(\d+)\s*h/i)
  const m = s.match(/(\d+)\s*m/i)
  const sec = s.match(/(\d+)\s*s/i)
  if (h) total += Number(h[1]) * 3600
  if (m) total += Number(m[1]) * 60
  if (sec) total += Number(sec[1])
  return total
}

/** 在 `[{title, content}]` 里按标题取值（掌瓦把指标名放在中文 title 里） */
function byTitle (list, title) {
  const rows = Array.isArray(list) ? list : []
  return rows.find(row => String(row?.title || '').replace(/\s/g, '') === title) || null
}

/** 取指标数值：`'18%'` → 18，`'405.3'` → 405.3 */
function metric (list, title) {
  const hit = byTitle(list, title)
  if (!hit) return 0
  return num(String(hit.content ?? '').replace('%', ''))
}

/**
 * `content` 是「模式 | 地图」拼起来的，而且层级不固定：
 *   竞技模式 | 天枢云阙
 *   万象地带 | 斗牛
 *   万象地带 | 团队激战 | 沙镇
 * 最后一段是地图，前面全是模式。
 */
function splitContent (content) {
  const parts = String(content || '').split('|').map(x => x.trim()).filter(Boolean)
  if (!parts.length) return { mode: '', map: '' }
  return {
    mode: parts.slice(0, -1).join(' · '),
    map: parts[parts.length - 1]
  }
}

const RESULT_OF = { 胜利: 'win', 失败: 'lose', 平局: 'draw', 胜: 'win', 负: 'lose' }

function resultOf (title) {
  const text = String(title || '').trim()
  return RESULT_OF[text] || (/胜/.test(text) ? 'win' : /负|败/.test(text) ? 'lose' : 'draw')
}

const accountOf = (ctx) => {
  const name = ctx.name || ctx.account
  return {
    puuid: ctx.role?.uid || '',
    id: ctx.tag ? `${name}#${ctx.tag}` : name,
    name,
    tag: ctx.tag || '',
    region: ctx.zone,
    card: { small: '', large: '', wide: '' }
  }
}

/* ---------------- 武器 id → 中文名 / valorant-api uuid ---------------- */

/**
 * 掌瓦用 5 位数字 id（`10404`），valorant-api 用 uuid。规律是
 * `1 + 分类(2 位) + 序号(2 位)`：01 佩枪 / 02 冲锋枪 / 03 霰弹枪 /
 * 04 步枪 / 05 狙击枪 / 06 重武器 / 07 近战。
 *
 * 已验证（抓包 roundoverview 里带名字的 6 把）：
 *   10101=标配  10104=鬼魅  10401=獠犬  10403=幻影  10404=狂徒  10601=战神
 * 其余按分类顺序对齐 valorant-api 的中文名，命名口径一致。
 *
 * ⚠️ 10504 故意没收录：它是第 4 把狙击枪，valorant-api 里没有对应条目
 *    （只有 飞将 950 / 莽侠 2400 / 冥驹 4700），名字查不到就别瞎猜，
 *    界面上会显示「武器 10504」，图标仍然用上游给的那张。
 *    哪天真名知道了，在 mate.json 里补一条：
 *      "weapons": { "map": { "10504": { "name": "真名", "uuid": "" } } }
 */
const WEAPON_MAP = {
  10101: { name: '标配', uuid: '29a0cfab-485b-f5d5-779a-b59f85e204a8' },
  10102: { name: '短炮', uuid: '42da8ccc-40d5-affc-beec-15aa47b42eda' },
  10103: { name: '狂怒', uuid: '44d4e95c-4157-0037-81b2-17841bf2e8e3' },
  10104: { name: '鬼魅', uuid: '1baa85b4-4c70-1284-64bb-6481dfc3bb4e' },
  10105: { name: '正义', uuid: 'e336c6b8-418d-9340-d77f-7a9e4cfe0702' },
  10109: { name: '追猎', uuid: '410b2e0b-4ceb-1321-1727-20858f7f3477' },
  10201: { name: '蜂刺', uuid: 'f7e1b454-4ad4-1063-ec0a-159e56b58941' },
  10202: { name: '骇灵', uuid: '462080d1-4035-2937-7c09-27aa2a5c27a7' },
  10301: { name: '雄鹿', uuid: '910be174-449b-c412-ab22-d0873436b21b' },
  10302: { name: '判官', uuid: 'ec845bf4-4f79-ddda-a3da-0db3774b2794' },
  10401: { name: '獠犬', uuid: 'ae3de142-4d85-2547-dd26-4e90bed35cf7' },
  10402: { name: '戍卫', uuid: '4ade7faa-4cf1-8376-95ef-39884480959b' },
  10403: { name: '幻影', uuid: 'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a' },
  10404: { name: '狂徒', uuid: '9c82e19d-4575-0200-1a81-3eacf00cf872' },
  10405: { name: '悍狼', uuid: '8db0a1bf-4a50-832a-4566-faaaa6d250ca' },
  10501: { name: '飞将', uuid: 'c4883e50-4494-202c-3ec3-6b8a9284f00b' },
  10502: { name: '冥驹', uuid: 'a03b24d3-4319-996d-0f8c-94bbfba1dfc7' },
  10503: { name: '莽侠', uuid: '5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c' },
  10601: { name: '战神', uuid: '55d8a0f4-4274-ca67-fe2c-06ab45efdf58' },
  10602: { name: '奥丁', uuid: '63e6c2b6-4a8e-869c-3d4c-e38355226584' },
  10701: { name: '近战武器', uuid: '2f59173c-4bed-b6c3-2191-dea9b58be9c7' }
}

function weaponOf (id, config) {
  const key = String(id || '')
  const override = config?.weapons?.map?.[key]
  return { ...(WEAPON_MAP[key] || {}), ...(override || {}) }
}

/* ---------------- 映射 ---------------- */

const MAPPING = {
  /**
   * 生涯面板。
   *
   *   overview = career/seasonoverview → data.list[0].body
   *     first_list  = [{当前段位, 赛季最高}]（都带 icon_url）
   *     second_list = [{胜率 62.5%}, {平均战斗得分 405.3}, {总场次 74}, {总时长 21h}]
   *     data.list[1].body.shooting = [{精准击败 18.4%, 596}, {身体 ...}, {腿部 ...}]
   *   stat = career/record/statdata → data[0]
   *     data.session = 总局数 58；progress_list[0].progress = 胜率 62.1
   *     data.list = [{title:'ACS',content:'405'}, KDA, 精准击败, 回合伤害, 回合击败, ...]
   *   agents = career/performance/agent → data.list[{agent_id, agent_name, part(场次), time(ms), kd, win_rate}]
   *   maps   = career/performance/map   → data.list[{map_id, name, map_icon, win_rate, kd, round_score}]
   *   recent = career/record/list       → battle_list[].score = 每场 ACS（画趋势条）
   */
  profile (raw, ctx) {
    const body = raw?.overview?.list?.[0]?.body || {}
    const firsts = body.first_list || []
    const secondList = body.second_list || []

    const rankItem = firsts.find(x => /当前段位/.test(x?.title || '')) || firsts[0] || {}
    const peakItem = firsts.find(x => /赛季最高|最高段位/.test(x?.title || '')) || firsts[1] || {}

    const mine = (raw?.stat || []).find(b => b?.header?.title === '我的数据') || (raw?.stat || [])[0] || {}
    const mineData = mine?.data || {}
    const metrics = mineData.list || []

    // 总局数用「我的数据」里的 session（58），跟 ACS/KDA 是同一口径；
    // 胜率用同一块的 progress（62.1）—— 别跟总览的 62.5 混着用，会出现
    // 「58 场 × 62.5% = 36.25 胜」这种自己都对不上的数。
    const matches = num(mineData.session)
    const winRate = rate(byTitle(mineData.progress_list, '胜率')?.progress)
    const wins = Math.round(matches * winRate)
    const kills = metric(metrics, '击败数')

    // 回合数没有直接给：用「击败数 ÷ 每回合击败」反算（887 / 1.2 ≈ 739）
    const perRoundKills = metric(metrics, '回合击败')
    const roundsPlayed = perRoundKills > 0 ? Math.round(kills / perRoundKills) : 0

    // 段位图标 url 里带等级号：.../level/603.png → 603
    const tierOf = (url) => num(String(url || '').match(/level\/(\d+)\.png/)?.[1])

    const seasonName = (raw?.overview?.type_list || [])
      .find(x => /赛季/.test(x?.title || ''))?.content || ''

    // 趋势条：用最近几场的 ACS（掌瓦列表里的 score 就是 ACS，不是比分）
    const recent = (raw?.recent?.battle_list || []).slice(0, 10).reverse()
    const acsValues = recent.map(r => num(r.score)).filter(v => v > 0)
    const min = Math.min(...acsValues)
    const max = Math.max(...acsValues)
    const trend = acsValues.map((value, i) => ({
      label: `#${i + 1}`,
      value,
      // 模板的条形高度是 px，容器只有 90px —— 按分布缩到 18~74，
      // 直接 value/3 会让柱子全部顶到天花板（ACS 通常在 150~500）
      height: max > min ? Math.round(18 + (value - min) / (max - min) * 56) : 46
    }))

    return {
      account: accountOf(ctx),
      rank: {
        tier: tierOf(rankItem.icon_url),
        tierName: rankItem.content || '未定级',
        // 掌瓦没有 RR 数值，只有段位图标；进度条交给插件显示 0
        rr: 0,
        icon: rankItem.icon_url || '',
        act: seasonName
      },
      peakRank: {
        tier: tierOf(peakItem.icon_url),
        tierName: peakItem.content || '',
        icon: peakItem.icon_url || '',
        act: seasonName
      },
      stats: {
        matches,
        wins,
        losses: Math.max(0, matches - wins),
        winRate,
        kills,
        deaths: metric(metrics, '死亡数'),
        assists: metric(metrics, '助攻数'),
        kd: metric(metrics, 'KDA'),
        acs: metric(metrics, 'ACS'),
        adr: metric(metrics, '回合伤害'),
        // 掌瓦没有 KAST，显示 0 比瞎编一个数强
        kast: 0,
        // 「精准击败」= 击杀里爆头的比例（18%），字段名叫 headshotRate，口径一致
        headshotRate: rate(byTitle(metrics, '精准击败')?.content),
        playtimeHours: num(String(byTitle(secondList, '总时长')?.content || '').replace(/[^\d.]/g, '')),
        roundsPlayed,
        // 原始指标留着，模板以后要加格子直接取
        extras: {
          firstBloods: metric(metrics, '率先击败'),
          clutch: metric(metrics, '高效火力'),
          teamAce: metric(metrics, '王牌小队'),
          flawless: metric(metrics, '完美团灭'),
          ace: metric(metrics, '王牌精锐'),
          thrifty: metric(metrics, '力克千钧'),
          roundWinRate: rate(byTitle(metrics, '回合胜率')?.content),
          perRoundKills
        }
      },
      agents: (raw?.agents?.list || []).map(a => ({
        id: String(a.agent_id || a.id || ''),
        name: a.agent_name || '',
        // icon 是立绘（竖图，面板用），image_url 是方头像
        portrait: a.icon || a.image_url || '',
        // part = 场次（不是百分比：27 场 × 20 分钟 ≈ 9 小时，跟 time 对得上）
        matches: num(a.part),
        winRate: rate(a.win_rate),
        kills: 0,
        deaths: 0,
        kd: num(a.kd),
        acs: 0,
        playtimeSeconds: Math.round(num(a.time) / 1000)
      })).sort((a, b) => b.matches - a.matches),
      maps: (raw?.maps?.list || []).map(m => ({
        id: String(m.map_id || ''),
        name: m.name || '',
        listView: m.map_icon || '',
        // 上游不给地图场次，模板里 0 就不显示「N 场」
        matches: 0,
        winRate: rate(m.win_rate),
        kd: num(m.kd),
        roundScore: num(m.round_score)
      })),
      trend,
      updatedAt: Date.now()
    }
  },

  /**
   * 战绩列表。
   *
   *   battle_list[] = {
   *     battle_id, result_title(胜利/失败/平局), hero_name, content("竞技模式 | 天枢云阙"),
   *     kda("12/16/9"), score(ACS), kda_score, ts(秒), image_url(特工头像),
   *     game_mode_id("101"), game_submode_id("101001"), score_level.level
   *   }
   *
   * ⚠️ 列表里**没有比分**（round_won/round_fail 实测恒为 "0"），只有详情页
   *    `winning_games / failed_games` 才有。所以这里 score 给「—」，
   *    点进详情才能看到 13-11。
   */
  matches (raw, ctx) {
    const rows = raw?.battle_list || []

    const list = rows.map((r, i) => {
      const [kills, deaths, assists] = String(r.kda || '').split('/').map(x => num(x))
      const { mode, map } = splitContent(r.content)

      return {
        // 详情要用 battle_id 去查，插件会把它原样带回来
        matchId: String(r.battle_id || r.match_id || `MATE-${i}`),
        mapId: '',
        mapName: map || '未知地图',
        mapIcon: '',
        mode: mode || r.game_mode || '',
        result: resultOf(r.result_title),
        // 比分分离给 undefined（JSON 里会被丢掉），插件就会显示 score 字段
        score: '—',
        agentId: '',
        agentName: r.hero_name || '',
        agentIcon: r.image_url || '',
        kills,
        deaths,
        assists,
        kd: num(r.kda_score),
        acs: num(r.score),
        adr: 0,
        headshotRate: 0,
        roundsPlayed: 0,
        durationSec: 0,
        // ts 是秒，插件侧按毫秒算，这里先乘好
        startedAt: num(r.ts) * 1000,
        accountId: ctx.account,
        // 下面两条是「上游给的」：D/A/SS 是掌瓦自己的评价等级，不是 MVP
        level: r.score_level?.level || '',
        tierChange: r.competitive_tier?.competitive_point_change || '',
        // 下面两条由 attachRanks() 事后填：全场名次（1 = 全场最佳）
        // 查不到就是 null，模板据此不显示，绝不猜
        rankInMatch: null,
        mvp: false
      }
    })

    const wins = list.filter(m => m.result === 'win').length
    const losses = list.filter(m => m.result === 'lose').length
    // 团队激战/斗牛没有 ACS，算均值时别把 0 也平均进去
    const acsList = list.map(m => m.acs).filter(v => v > 0)
    const kdList = list.map(m => m.kd).filter(v => v > 0)

    return {
      account: accountOf(ctx),
      list,
      summary: {
        matches: list.length,
        wins,
        losses,
        // 平局不算进胜率分母（跟游戏内一致）
        winRate: wins + losses ? Math.round(wins / (wins + losses) * 1000) / 1000 : 0,
        acs: acsList.length ? Math.round(acsList.reduce((s, v) => s + v, 0) / acsList.length) : 0,
        kd: kdList.length ? Math.round(kdList.reduce((s, v) => s + v, 0) / kdList.length * 100) / 100 : 0
      }
    }
  },

  /**
   * 单局详情。
   *
   *   scoreboard.detail = { used_agent, used_map{id,name,icon}, game_mode_name,
   *                         winning_games, failed_games, duration("36m25s"),
   *                         game_start_time(秒), my_team }
   *   scoreboard.scoreboard[] = { user_name, team(Blue/Red), used_agent{name,icon,avatar},
   *                               score(ACS), kda_score, kill, death, assist,
   *                               total_head_shots, head_shots_rate("12.90%"),
   *                               first_kill_count, plant_count, defuse_count,
   *                               economy, tier_name, tier_icon, is_me("1"/"0") }
   *   rounds.rounds[] = { round_num(-1 是总览), is_win("1"/"0"), is_attack("1"/"0"),
   *                       kills, deaths, assists, damage }
   */
  match (raw, ctx) {
    const detail = raw?.board?.detail || {}
    const rows = raw?.board?.scoreboard || []

    const scoreSelf = num(detail.winning_games)
    const scoreEnemy = num(detail.failed_games)
    // victory: 1 胜 / 0 负 / -1 平；拿不准就直接比回合数，比它可靠
    const result = scoreSelf > scoreEnemy ? 'win' : scoreSelf < scoreEnemy ? 'lose' : 'draw'

    /**
     * 「我是哪一队」：优先用 `detail.my_team`，没有就找 is_me 那一条。
     * ⚠️ Blue / Red 是**阵营**（攻守轮换不会变），所以不能写死「蓝=我方」——
     * 我在红队时红才是我方。模板只认 side，不认颜色含义。
     */
    const selfRow = rows.find(p => String(p.is_me) === '1')
    const declared = String(detail.my_team || '').toLowerCase()
    const myTeam = declared === 'blue' || declared === 'red'
      ? declared
      : (String(selfRow?.team || '').toLowerCase() === 'red' ? 'red' : 'blue')

    const players = rows.map(p => {
      const agent = p.used_agent || {}
      const team = String(p.team || '').toLowerCase() === 'red' ? 'red' : 'blue'
      return {
        id: p.user_name || '',
        name: p.user_name || '',
        tag: '',
        agentId: '',
        agent: agent.name || '',
        agentName: agent.name || '',
        // 记分板用 icon（立绘）太花，头像更清楚
        agentIcon: agent.avatar || agent.icon || '',
        // 队伍色（蓝/红）与敌我，模板两个都要用：色块看阵营，标签看敌我
        team,
        side: team === myTeam ? 'mine' : 'enemy',
        kills: num(p.kill),
        deaths: num(p.death),
        assists: num(p.assist),
        kd: num(p.kda_score),
        acs: num(p.score),
        econ: num(p.economy),
        headshots: num(p.total_head_shots),
        headshotRate: rate(p.head_shots_rate),
        firstBloods: num(p.first_kill_count),
        plants: num(p.plant_count),
        defuses: num(p.defuse_count),
        // ⚠️ is_me 是字符串 "1"/"0"，用 !! 会把 "0" 当真
        isSelf: String(p.is_me) === '1',
        rank: { tierName: p.tier_name || '', icon: p.tier_icon || '' }
      }
    })

    const rounds = (raw?.rounds?.rounds || [])
      // 第一条 round_num = -1 是「总览」，不是真回合
      .filter(r => num(r.round_num) > 0)
      .map((r, i) => ({
        index: num(r.round_num) || i + 1,
        side: String(r.is_attack) === '1' ? 'atk' : 'def',
        result: String(r.is_win) === '1' ? 'win' : 'lose',
        kills: num(r.kills),
        deaths: num(r.deaths),
        assists: num(r.assists),
        damage: num(r.damage)
      }))

    // detail.rank = 十个人按 ACS 排序后的名次（实测 10/10 局一致），1 就是全场最佳
    const rankInMatch = num(detail.rank)

    return {
      matchId: String(raw.battleId || ''),
      mapId: String(detail.used_map?.id || ''),
      mapName: detail.used_map?.name || raw.mapHint || '未知地图',
      mapIcon: detail.used_map?.icon || '',
      mode: detail.game_mode_name || raw.modeHint || '',
      result,
      scoreSelf,
      scoreEnemy,
      score: `${scoreSelf}-${scoreEnemy}`,
      durationSec: seconds(detail.duration),
      startedAt: num(detail.game_start_time) * 1000,
      myTeam,
      rankInMatch,
      mvp: rankInMatch === 1,
      rounds,
      players
    }
  },

  /**
   * 枪械熟练度。
   *
   *   performance/gun → data.list[] = { id("10404"), name(**空串**),
   *                                     image_url, kill, kill_head("22.0" = 率),
   *                                     kill_round(每回合击杀), kill_farthest(米) }
   *
   * 只有四个数，没有总命中/总伤害 —— 所以下面把「击杀」当命中数来凑
   * `headshots / bodyshots`（模板要的是「爆头/身体/腿」三连的比例），
   * 算出来的爆头率跟上游的 `kill_head` 完全一致，因为分子分母同源。
   */
  weapons (raw, ctx, config) {
    const rows = raw?.list || []

    const list = rows.map(w => {
      const id = String(w.id || '')
      const info = weaponOf(id, config)
      const kills = num(w.kill)
      const headRate = rate(w.kill_head)
      const headshots = Math.round(kills * headRate)
      const perRound = num(w.kill_round)

      return {
        // 有 uuid 就填 uuid：插件拿它去 valorant-api 查图标/分类/价格，一箭三雕
        weaponId: info.uuid || id,
        legacyId: id,
        name: info.name || w.name || `武器 ${id}`,
        icon: w.image_url || '',
        kills,
        headshots,
        bodyshots: Math.max(0, kills - headshots),
        legshots: 0,
        // 上游不给枪械总伤害，模板会显示「—」
        damage: 0,
        roundsUsed: perRound > 0 ? Math.round(kills / perRound) : 0,
        killsPerRound: perRound,
        farthest: num(w.kill_farthest)
      }
    }).sort((a, b) => b.kills - a.kills)

    return {
      account: accountOf(ctx),
      season: '当前赛季',
      list
    }
  }
}

export { MAPPING, WEAPON_MAP }
export default mateappProvider
