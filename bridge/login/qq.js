/**
 * QQ 扫码登录（掌瓦版）。
 *
 * 走的是「QQ 互联 OAuth 扫码」，不是掌瓦 App 里那个「扫一扫」——
 * 后者是掌瓦去授权 PC 客户端，方向相反。
 *
 *   1. xlogin      → 拿 pt_login_sig / idt / jsver
 *   2. ptqrshow    → 二维码 PNG（s=8 才有 264×264，不传只有 99×99，扫不动）
 *   3. ptqrlogin   → 轮询 ptuiCB(...)：66 未扫 / 67 待确认 / 0 成功 / 65 失效
 *   4. check_sig   → 追跳转，落到 auth://tauth.qq.com/#access_token=…&openid=…
 *   5. login_by_qq → 拿上面两个换掌瓦自己的凭证 { user_id, wt, ct, ctt, sk }
 *   6. get_main_role_raw → 认角色名 + 拿 scene
 *
 * ## 为什么之前「被风控」
 *
 * 第一版按**网页站点**的参数来（daid=383、pt_3rd_aid=0、浏览器 UA），
 * ptqrlogin 稳定返回 HTTP 200 + 空 body。换成**掌瓦 App 自己**的那套参数就好：
 * daid=381、pt_3rd_aid=102061775（QQ 开放平台移动应用）、mval 的 UA，
 * 外加 `X-Requested-With: com.tencent.apps.valorant`，轮询就正常回 ptuiCB 了。
 *
 * 参数来源：astrbot_plugin_valorant_analysis（AGPL-3.0）整理的值，
 * 这里只借参数、实现是独立写的。`sign` / `h5sig` 这类一次性签名官方会换，
 * 失效时按抓包结果替换即可（都在下面常量里）。
 */

/** 掌瓦 App 的 UA —— ptlogin 认这个，别换成浏览器 UA */
const UA_MVAL = 'mval/2.4.0.10053 Channel/10068 Manufacturer/Xiaomi '
  + 'Mozilla/5.0 (Linux; Android 14; 23117RK66C Build/V417IR; wv) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
  + 'Chrome/101.0.4951.61 Mobile Safari/537.36'

const AID = process.env.QQ_AID || '716027609'
const DAID = process.env.QQ_DAID || '381'
/** QQ 开放平台移动应用的 appid（掌瓦用的就是这个） */
const THIRD_AID = process.env.QQ_THIRD_AID || '102061775'

const PTQR_SHOW = 'https://xui.ptlogin2.qq.com/ssl/ptqrshow'
const PTQR_LOGIN = 'https://xui.ptlogin2.qq.com/ssl/ptqrlogin'
const XLGOIN = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin'
const MVAL_LOGIN = 'https://app.mval.qq.com/go/auth/login_by_qq'
const MVAL_ROLE = 'https://app.mval.qq.com/go/account/get_main_role_raw'

/**
 * ⚠️ 腾讯已把「check_sig → auth://」这一跳的主机 DNS 黑洞。
 *
 * 2026-10 实测：以下主机在阿里/腾讯/Google 公共 DNS 上一律返回 0.0.0.1，
 * 也就是说**不是网络问题、换 IP 没用**，是官方下线了这两台前置机：
 *
 *   ptlogin4.openmobile.qq.com  → 0.0.0.1   （Move 端 App 登录落地）
 *   ptlogin4.graph.qq.com       → 0.0.0.1   （网站应用登录落地）
 *   ptlogin4.web.qq.com         → 0.0.0.1
 *
 * 所以 ptqrlogin 返回 code=0（扫码+确认都成功）之后，跟着 302 去换 token 必然断。
 * 这里保留一份「还活着」的候选主机，扫码成功后**逐个改写落点主机再试**：
 * 同样的 path / query 换到活主机上，有一部分集群仍然认这套 sigx。
 * 想自己加候选：QQ_CHECKSIG_HOSTS=host1,host2
 */
const CHECKSIG_BLACKHOLE = new Set([
  'ptlogin4.openmobile.qq.com',
  'ptlogin4.graph.qq.com',
  'ptlogin4.web.qq.com'
])

const CHECKSIG_FALLBACKS = (process.env.QQ_CHECKSIG_HOSTS
  || 'ptlogin4.qq.com,ptlogin2.qq.com,ssl.ptlogin2.qq.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

/** 掌瓦客户端指纹，官方换版本时要跟着换 */
const MCODE = process.env.MVAL_MCODE || '132f0a77d34402abc8463d60100011d19b0e'
const DEVICE = process.env.MVAL_DEVICE || '23117RK66C'

const TIMEOUT = Number(process.env.LOGIN_TIMEOUT) || 15000

/** 腾讯的 hash33：ptqrtoken = hash33(qrsig) */
function hash33 (input) {
  let hash = 0
  const text = String(input)
  for (let i = 0; i < text.length; i++) hash += (hash << 5) + text.charCodeAt(i)
  return hash & 0x7FFFFFFF
}

/** 一个够用就好的 cookie jar：Set-Cookie 收进来，发出去时拍平成一行 */
function makeJar () {
  const map = new Map()
  return {
    absorb (setCookies) {
      for (const line of setCookies || []) {
        const pair = String(line).split(';')[0]
        const i = pair.indexOf('=')
        if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
      }
    },
    get (name) { return map.get(name) || '' },
    header () { return [...map].map(([k, v]) => `${k}=${v}`).join('; ') },
    dump () { return Object.fromEntries(map) },
    load (obj) { for (const [k, v] of Object.entries(obj || {})) map.set(k, v) }
  }
}

/** xlogin 的地址，`time` 每次都得是新的 */
function buildLoginUrl () {
  const qs = new URLSearchParams({
    pt_enable_pwd: '1',
    appid: AID,
    pt_3rd_aid: THIRD_AID,
    daid: DAID,
    pt_skey_valid: '0',
    style: '35',
    force_qr: '1',
    autorefresh: '1',
    s_url: 'http://connect.qq.com',
    refer_cgi: 'm_authorize',
    ucheck: '1',
    fall_to_wv: '1',
    status_os: '12',
    redirect_uri: 'auth://tauth.qq.com/',
    client_id: THIRD_AID,
    pf: 'openmobile_android',
    response_type: 'token',
    scope: 'all',
    sdkp: 'a',
    sdkv: '3.5.17.lite',
    sign: 'a6479455d3e49b597350f13f776a6288',
    status_machine: 'MjMxMTdSSzY2Qw==',
    switch: '1',
    time: String(Math.floor(Date.now() / 1000)),
    show_download_ui: 'true',
    loginty: '6'
  })
  // URLSearchParams 会把 auth:// 编成 auth%3A%2F%2F，正是要的
  return `${XLGOIN}?${qs}`
}

/** 轮询时要带上的一坨「我是谁、我要什么权限」，缺了 ptqrlogin 会当无效会话 */
function buildOpenLoginData (idt) {
  const qs = new URLSearchParams({
    which: '',
    refer_cgi: 'm_authorize',
    response_type: 'token',
    client_id: THIRD_AID,
    state: '',
    display: '',
    openapi: '1011',
    switch: '1',
    src: '1',
    sdkv: '3.5.17.lite',
    sdkp: 'a',
    tid: idt,
    pf: 'openmobile_android',
    need_pay: '0',
    browser: '0',
    browser_error: '',
    serial: '',
    token_key: '',
    redirect_uri: 'auth://tauth.qq.com/',
    page_type: '1',
    has_auth: '1',
    update_auth: '1',
    auth_time: String(Date.now()),
    loginfrom: '',
    loginty: '6'
  })
  return qs.toString()
}

/**
 * `ptuiCB('66','0','','0','二维码未失效。', '')`
 *
 * ⚠️ 最后两段之间是 `', '`（逗号后面**有空格**），早先把分隔符写成 `','`
 *    导致一直解析失败、被当成「意料之外的格式」。用 `,\s*` 兜住。
 */
function parsePtuiCB (text) {
  const m = String(text || '').match(/ptuiCB\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'/)
  if (!m) return null
  return {
    code: m[1],
    redirect: unescapeUrl(m[3]),
    message: m[5],
    nickname: m[6]
  }
}

function unescapeUrl (url) {
  return String(url || '').replace(/\\\//g, '/').replace(/\\x26/g, '&')
}

/**
 * 从一段文本/URL 里抠 openid + access_token。
 *
 * 形状有好几种：`auth://tauth.qq.com/#access_token=…&openid=…`、
 * `_Callback({"url":"auth://…"})`、以及层层 URL 编码过的 `u1=` 嵌套。
 * 官方页面改版就得在这儿补规则。
 */
function extractToken (raw) {
  const direct = parseTokenParams(raw)
  if (direct.openid && direct.access_token) return direct
  const m = String(raw || '').match(/auth:\/\/tauth\.qq\.com\/[^\s"'<>\\]+/)
  if (m) {
    const fromUrl = parseTokenParams(m[0])
    if (fromUrl.openid && fromUrl.access_token) return fromUrl
  }
  return direct
}

export function parseTokenParams (raw) {
  const out = {}
  let text = unescapeUrl(raw)
  // 解几层编码：外面常套两层
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(text); i++) text = decodeURIComponent(text)
  const hashAt = text.indexOf('#')
  const query = hashAt >= 0 ? text.slice(hashAt + 1) : text
  for (const [k, v] of new URLSearchParams(query.replace(/^&/, ''))) {
    if (v) out[k] = v
  }
  return { openid: out.openid || '', access_token: out.access_token || '' }
}

/**
 * 追一段 302 链，直到拿到 auth:// 里的 token，或者链断掉。
 * 抽出来是为了「同一个 check_sig，换不同主机名多试几次」。
 */
async function followHops (startUrl, referer, jar, trace) {
  let url = unescapeUrl(startUrl).trim()
  const seen = new Set()

  for (let hop = 0; hop < 6; hop++) {
    if (!url || seen.has(url)) break
    seen.add(url)

    const now = extractToken(url)
    if (now.openid && now.access_token) return now

    let res
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          'User-Agent': UA_MVAL,
          Accept: '*/*',
          Referer: referer,
          'X-Requested-With': 'com.tencent.apps.valorant',
          ...(jar.header() ? { Cookie: jar.header() } : {})
        }
      })
    } catch (error) {
      // 0.0.0.1 / NXDOMAIN 会在这里炸
      if (trace) trace.push(`${new URL(url).hostname}: ${error.cause?.code || error.message}`)
      break
    }
    jar.absorb(res.headers.getSetCookie?.())

    const location = res.headers.get('location') || ''
    if (location) {
      url = /^https?:/.test(location) || location.startsWith('auth://')
        ? location
        : new URL(location, url).toString()
      continue
    }

    const body = await res.text().catch(() => '')
    const fromBody = extractToken(body)
    if (fromBody.openid && fromBody.access_token) return fromBody

    const next = (body.match(/(https?:\/\/[^\s"'<>]*check_sig[^\s"'<>]*)/i) || [])[1]
      || (body.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) || [])[1]
    if (next && next !== url) { url = unescapeUrl(next); continue }
    break
  }
  return null
}

/**
 * 追 check_sig 跳转，直到拿到 auth:// 或 body 里出现 token。
 *
 * 2026-10 起 ptlogin4.openmobile / ptlogin4.graph 被 DNS 黑洞（0.0.0.1），
 * 所以扫码成功后不能只跟官方给的那条 302——把主机名换成还活着的候选再试一轮。
 * trace 会把每一跳的结果记下来，失败时一起抛给用户，省得「扫码成功但没拿到授权」这种哑巴提示。
 */
export async function resolveCheckSig (startUrl, referer, jar, trace = []) {
  const raw = unescapeUrl(startUrl).trim()
  if (!raw) return null

  let parsed
  try { parsed = new URL(raw) } catch { return null }

  const candidates = []
  if (!CHECKSIG_BLACKHOLE.has(parsed.hostname)) candidates.push(raw)
  for (const host of CHECKSIG_FALLBACKS) {
    try {
      const u = new URL(raw)
      u.hostname = host
      candidates.push(u.toString())
    } catch {}
  }

  for (const url of [...new Set(candidates)]) {
    let host = url
    try { host = new URL(url).hostname } catch {}
    const token = await followHops(url, referer, jar, trace)
    if (token?.openid && token?.access_token) {
      trace.push(`✓ ${host} 拿到 openid/access_token`)
      return token
    }
    trace.push(`✗ ${host} 没拿到 token`)
  }
  return null
}

/**
 * 拿 QQ 的 openid + access_token 换掌瓦凭证。
 *
 * ⚠️ 这一步才是「登录掌瓦」的真正入口，之前一直卡在以为要自己算 448 字符的 ct ——
 *    不用算，掌瓦直接换给你。
 */
export async function exchangeMval (openid, accessToken) {
  const res = await fetch(`${MVAL_LOGIN}?source_game_zone=agame&game_zone=agame`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA_MVAL,
      // 换凭证这一步要的是「未登录」的 cookie，带上反而会被拒
      Cookie: 'clientType=9; openid=null; access_token=null'
    },
    body: JSON.stringify({
      clienttype: 9,
      config_params: { client_dev_name: DEVICE, lang_type: 0 },
      login_info: { appid: Number(THIRD_AID), openid, qq_info_type: 5, sig: accessToken, uin: 0 },
      mappid: 10200,
      mcode: MCODE,
      source_game_zone: 'agame',
      game_zone: 'agame'
    })
  })

  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {
    // 服务端偶发把响应体拼两遍
    const i = text.indexOf('}{')
    if (i > 0) { try { json = JSON.parse(text.slice(0, i + 1)) } catch {} }
  }
  if (!json) throw fail('掌瓦返回的不是 JSON，换凭证失败', 'UPSTREAM')
  if (String(json.result) !== '0') {
    // 掌瓦把上游错误码塞在 errMsg 文本里（形如 "login by qq fail ret=10104"）。
    // 10104 = QQ token 校验不过：过期、被顶号、或者不是 appid 102061775 的 token。
    const detail = String(json.errMsg || json.err_msg || json.msg || '')
    const ret = (detail.match(/ret=(\d+)/) || [])[1]
    const explain = ret === '10104'
      ? 'QQ token 校验不过（10104）：token 过期/被顶号，或不是掌瓦自己 appid（102061775）发的 token'
      : (json.msg || '没有说明原因')
    throw fail(`换掌瓦凭证失败（result=${json.result}${ret ? `, ret=${ret}` : ''}）：${explain}`, 'UPSTREAM_AUTH')
  }

  const info = json.data?.login_info || {}
  if (!info.user_id) throw fail('掌瓦没返回 user_id，换凭证没成功', 'UPSTREAM_AUTH')
  return info
}

/**
 * 按掌瓦的 cookie 形状拼一行。
 * 顺序跟抓包看到的一致，多一个少一个都可能被服务端当异构客户端。
 */
export function buildCookie ({ openid, accessToken, userId, tid }) {
  return [
    'clientType=9',
    `appid=${THIRD_AID}`,
    'acctype=qc',
    `openid=${openid}`,
    `access_token=${accessToken}`,
    `userId=${userId}`,
    'accountType=5',
    `tid=${tid}`
  ].join('; ')
}

/**
 * 认角色 + 拿 scene。同一个 QQ 下可能有端游(agame)和手游(codev)两个角色。
 * 导出是为了能脱离扫码单独验证（给一份 cookie 就能看它认不认得出）。
 */
export async function fetchRole (cookie) {
  const res = await fetch(`${MVAL_ROLE}?source_game_zone=codev&game_zone=codev`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA_MVAL, Cookie: cookie },
    body: JSON.stringify({ clienttype: 9, config_params: { client_dev_name: DEVICE, lang_type: 0 } })
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {
    const i = text.indexOf('}{')
    if (i > 0) { try { json = JSON.parse(text.slice(0, i + 1)) } catch {} }
  }
  if (!json || String(json.result) !== '0') return null

  const list = Object.values(json.data?.list || {})
  // 这个网关只查手游（codev），所以优先取 codev 那个角色
  const role = list.find(r => r.gameId === 'codev') || list[0] || null
  if (!role) return null
  return {
    gameId: role.gameId || '',
    name: role.role_name || '',
    uid: role.uuid || '',
    roleId: String(role.game_role_id || ''),
    level: role.role_level || '',
    tierText: role.tier_text || '',
    scene: role.scene || '',
    icon: role.icon_url || ''
  }
}

function fail (message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 纯 HTTP 版适配器（现在的定位是**降级方案**）。
 *
 * 它自己出码、自己轮询、自己追 check_sig。前两步都很稳，
 * 第三步在 2026-10 之后基本走不通了（见文件头 CHECKSIG_BLACKHOLE），
 * 所以默认路径改成了浏览器版 `qqpage.js`，这里只留作没浏览器时的退路。
 */
const httpAdapter = {
  name: 'qq',

  async start () {
    const jar = makeJar()
    const loginUrl = buildLoginUrl()

    // 1) xlogin
    const page = await fetch(loginUrl, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        'User-Agent': UA_MVAL,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://openmobile.qq.com/',
        'X-Requested-With': 'com.tencent.apps.valorant',
        Cookie: 'accountType=5; clientType=9'
      }
    }).then(async res => {
      jar.absorb(res.headers.getSetCookie?.())
      return res.text()
    }).catch(error => {
      throw fail(`连不上 QQ 登录页：${error.message}`, 'UPSTREAM')
    })

    const loginSig = jar.get('pt_login_sig')
    const idt = jar.get('idt') || String(Math.floor(Date.now() / 1000))
    // jsver 是腾讯前端版本号，隔几周就换一次。优先从 xlogin 页面里现抓，
    // 抓不到才用兜底值（2026-10 实测为 3ea7b82c，旧值 28d22679 已经过期，
    // 拿旧值轮询会被判「非本客户端」而返回空 body）。
    const jsver = (page.match(/\/monorepo\/([0-9A-Za-z]+)\/ptlogin\/js\//) || [])[1]
      || (page.match(/jsver\s*[:=]\s*['"]([0-9a-zA-Z]+)['"]/) || [])[1]
      || '3ea7b82c'

    // 2) 出码。s=8 才是 264×264，不传只有 99×99（太小，手机扫不动）
    const qrUrl = `${PTQR_SHOW}?${new URLSearchParams({
      s: '8',
      e: '0',
      appid: AID,
      type: '0',
      t: String(Math.random()),
      u1: 'http://connect.qq.com',
      daid: DAID,
      pt_3rd_aid: THIRD_AID
    })}`

    const qrRes = await fetch(qrUrl, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        'User-Agent': UA_MVAL,
        Accept: 'image/*',
        Referer: loginUrl,
        'X-Requested-With': 'com.tencent.apps.valorant',
        Cookie: jar.header()
      }
    })
    jar.absorb(qrRes.headers.getSetCookie?.())

    const buf = Buffer.from(await qrRes.arrayBuffer())
    const qrsig = jar.get('qrsig')
    if (!qrsig) throw fail('出码失败：QQ 没返回 qrsig，可能被风控了，稍后再试', 'UPSTREAM')
    if (!buf.length) throw fail('出码失败：二维码是空的', 'UPSTREAM')

    return {
      qr: `data:image/png;base64,${buf.toString('base64')}`,
      state: {
        jar: jar.dump(),
        qrsig,
        ptqrtoken: hash33(qrsig),
        loginSig,
        idt,
        jsver,
        loginUrl
      }
    }
  },

  async poll (state) {
    if (!state?.qrsig) return { status: 'blocked', message: '会话状态缺失，重新发一次 #瓦扫码登录' }

    const jar = makeJar()
    jar.load(state.jar)

    const params = new URLSearchParams({
      u1: 'http://connect.qq.com',
      from_ui: '1',
      type: '1',
      ptlang: '2052',
      ptqrtoken: String(state.ptqrtoken),
      daid: DAID,
      aid: AID,
      pt_3rd_aid: THIRD_AID,
      pt_openlogin_data: buildOpenLoginData(state.idt),
      device: '2',
      ptopt: '1',
      pt_uistyle: '35',
      jsver: state.jsver || '28d22679',
      r: String(Math.random())
    })
    if (state.loginSig) params.set('login_sig', state.loginSig)

    const res = await fetch(`${PTQR_LOGIN}?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        // 官方客户端轮询时 UA 后面带这一截
        'User-Agent': `${UA_MVAL} tencent_game_emulator`,
        Accept: '*/*',
        Referer: state.loginUrl,
        'X-Requested-With': 'com.tencent.apps.valorant',
        Cookie: jar.header()
      }
    })
    jar.absorb(res.headers.getSetCookie?.())

    const text = (await res.text()).trim()
    if (!text) {
      return {
        status: 'waiting',
        upstreamEmpty: true,
        hint: 'QQ 的轮询接口没给响应（风控）。重发一次通常就好了；一直这样说明参数过期了，看 bridge/login/qq.js 里的常量。'
      }
    }

    const cb = parsePtuiCB(text)
    if (!cb) {
      // 带上原文：官方偶尔改格式，没有原文根本没法查
      return { status: 'waiting', message: `QQ 返回了意料之外的格式：${text.slice(0, 80)}`, raw: text.slice(0, 300) }
    }

    switch (cb.code) {
      case '66':
        return { status: 'waiting', message: '等待扫码' }
      case '67':
        return { status: 'scanned', message: '已扫描，请在手机上点「确认登录」' }
      case '65':
        return { status: 'expired', message: '二维码失效了，重新发 #瓦扫码登录' }
      case '0': {
        const trace = []
        const token = await resolveCheckSig(cb.redirect, state.loginUrl, jar, trace)
        if (!token?.openid || !token?.access_token) {
          /**
           * 走到这儿说明扫码/确认都成功了，死在「换 token」这一跳。
           * 2026-10 的实测原因是腾讯把 ptlogin4.openmobile / ptlogin4.graph
           * 的 DNS 指到了 0.0.0.1（见文件头注释），这里把每一跳的结果回给用户，
           * 别让它看起来像「你没扫」。
           */
          return {
            status: 'blocked',
            message: '扫码成功，但 QQ 没把授权 token 交出来（官方换票前置机已下线）',
            hint: `改动落点主机也没换到 token：${trace.join('；') || '无跳转记录'}。`
              + '这不是参数问题，是腾讯侧的 check_sig 主机（ptlogin4.openmobile.qq.com）'
              + '被 DNS 黑洞到 0.0.0.1。想继续用请改走抓包导入，或用 tools/mval-login.mjs 手动喂 token。',
            raw: trace.join(' | ').slice(0, 500)
          }
        }

        const info = await exchangeMval(token.openid, token.access_token)
        const userId = String(info.user_id || '')
        const tid = String(info.wt || '')
        const cookie = buildCookie({
          openid: token.openid,
          accessToken: token.access_token,
          userId,
          tid
        })

        // 认角色 + 拿 scene。拿不到也算登录成功，只是要用户自己补 scene
        const role = await fetchRole(cookie).catch(() => null)

        return {
          status: 'confirmed',
          message: role?.name ? `登录成功：${role.name}` : '登录成功，但没认出角色名',
          profile: {
            nickname: cb.nickname ? decodeURIComponent(cb.nickname) : '',
            userId,
            roleName: role?.name || '',
            tierText: role?.tierText || ''
          },
          // 交给 provider.saveLogin()：这一坨已经是可以直接查战绩的东西了
          credential: {
            cookie,
            scene: role?.scene || '',
            sceneDetail: role?.scene || '',
            role: {
              uid: role?.uid || '',
              roleId: role?.roleId || '',
              name: role?.name || '',
              zone: role?.gameId || 'codev'
            },
            extra: { openid: token.openid, uin: info.uin || 0, ct: info.ct || '', ctt: info.ctt || '' }
          }
        }
      }
      default:
        // code 和原文都带上：官方改格式/换错误码时，没有这两样根本没法查。
        // 100044 = sign of app is error，是「应用签名」不对，不是码的问题。
        return {
          status: 'waiting',
          code: cb.code,
          raw: text.slice(0, 300),
          message: cb.message || `未知状态 ${cb.code}`
        }
    }
  }
}

/**
 * 把「浏览器拿到的 token」变成「能查战绩的掌瓦凭证」。
 * 页面版和 HTTP 版拿到 token 之后走的是同一段，所以抽出来。
 */
async function finishLogin ({ openid, accessToken, nickname = '' }) {
  const info = await exchangeMval(openid, accessToken)
  const userId = String(info.user_id || '')
  const cookie = buildCookie({ openid, accessToken, userId, tid: String(info.wt || '') })
  const role = await fetchRole(cookie).catch(() => null)

  return {
    status: 'confirmed',
    message: role?.name ? `登录成功：${role.name}` : '登录成功，但没认出角色名',
    profile: {
      nickname,
      userId,
      roleName: role?.name || '',
      tierText: role?.tierText || ''
    },
    credential: {
      cookie,
      scene: role?.scene || '',
      sceneDetail: role?.scene || '',
      role: {
        uid: role?.uid || '',
        roleId: role?.roleId || '',
        name: role?.name || '',
        zone: role?.gameId || 'codev'
      },
      extra: { openid, uin: info.uin || 0, ct: info.ct || '', ctt: info.ctt || '' }
    }
  }
}

/**
 * 默认适配器：**浏览器优先**，没浏览器就退回纯 HTTP。
 *
 * 页面版的状态机不一样 —— 它自己会在后台跑完整条流程，
 * 所以 `start()` 顺手把后台任务挂上，`poll()` 只是「查一下完事没有」，
 * 不去阻塞网关的轮询请求。
 */
export const qqAdapter = {
  name: 'qq',

  async start () {
    if (process.env.QQ_MODE !== 'http') {
      let session = null
      // qqpage.js 反过来 import 了本文件的 parseTokenParams / resolveCheckSig，
      // 所以这里用动态 import 打断静态循环
      let fetchOpenidFn = null
      try {
        const mod = await import('./qqpage.js')
        fetchOpenidFn = mod.fetchOpenid
        session = await mod.createQQPageSession({
          onLog: (msg) => process.env.LOGIN_DEBUG === '1' && console.log('[qq-page]', msg)
        })
      } catch (error) {
        // 只有「压根没浏览器」才降级；出码失败是参数/上游问题，降级也救不了
        if (error?.code !== 'NO_BROWSER') throw error
        console.warn('[login] 没有可用浏览器，QQ 降级为纯 HTTP（可能卡在 check_sig）')
      }

      if (session) {
        const state = {
          mode: 'page',
          session,
          scanned: false,
          result: null,
          error: null,
          /** 码过期时不用重开浏览器：点一下页面的刷新，拿新 qrsig 继续 */
          refreshQR: (opts) => session.refreshQR(opts),
          /** 页面当前文字 —— 排障时最有用的一句话 */
          pageText: () => session.pageText()
        }

        // 后台跑：等扫码 → 换 openid → 换掌瓦凭证
        state.task = (async () => {
          try {
            const cb = await session.waitForCallback({
              onStatus: () => { state.scanned = true }
            })
            const openid = await fetchOpenidFn(cb.access_token)
            if (!openid) throw fail('授权回调里没换到 openid（graph.qq.com 没给）', 'UPSTREAM_AUTH')
            state.result = await finishLogin({ openid, accessToken: cb.access_token })
          } catch (error) {
            state.error = error
          } finally {
            await session.close().catch(() => {})
          }
        })()

        return {
          qr: session.qr,
          state,
          // 插件/网关可以据此展示「用的是哪种模式」
          mode: 'page'
        }
      }
    }

    return httpAdapter.start()
  },

  async poll (state) {
    if (state?.mode !== 'page') return httpAdapter.poll(state)

    if (state.error) {
      const code = state.error.code || ''
      const terminal = ['QR_TIMEOUT', 'CANCELLED', 'UPSTREAM_AUTH', 'UPSTREAM'].includes(code)
      return {
        status: terminal ? (code === 'QR_TIMEOUT' ? 'expired' : 'blocked') : 'waiting',
        message: state.error.message,
        hint: code === 'UPSTREAM_AUTH'
          ? 'QQ 那边授权成功了，但掌瓦不认这个 token。通常是 appid 不对（应为 102061775），或该 token 已过期。'
          : undefined
      }
    }

    if (state.result) return state.result

    return state.scanned
      ? { status: 'scanned', message: '已扫描，请在手机上点「确认登录」' }
      : { status: 'waiting', message: '等待扫码' }
  },

  /** 网关取消会话时会调它，把浏览器页面关掉 */
  async close (state) {
    if (state?.mode === 'page') {
      try { await state.session?.close() } catch {}
    }
  }
}

export default qqAdapter
