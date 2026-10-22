/**
 * 微信「扫码登录 SDK」出码模块 —— 纯 HTTP，不需要浏览器，也不需要 redirect_uri 白名单。
 *
 * ## 为什么这条路能走通
 *
 * 微信的扫码登录有**两套**完全不同的东西，之前一直卡在错误的那套上：
 *
 *   ❌ 网站应用扫码（`/connect/qrconnect`）
 *      要 appid + 已在开放平台备案的「授权回调域」。掌瓦的 appid 不是我们的，
 *      回调域是腾讯的域名，我们既改不了也收不到 code。
 *
 *   ✅ 扫码 SDK（`/connect/sdk/qrconnect`）
 *      只要一串 `sdk_ticket` + 用它算的 sha1 签名。**没有 redirect_uri 这个概念**，
 *      code 直接由轮询接口吐给你。这也正是手机 App 里「用微信扫一扫登录」用的那套。
 *
 * 而 `sdk_ticket` 本来要 AppSecret 去换（那是服务端的事），但掌瓦自己开了个
 * 免鉴权的取票接口 `/go/auth/get_sdk_ticket` —— 这一下就把整条路打通了。
 *
 * ## 逆向来源
 *
 * `掌上无畏契约 2.9.0` classes8.dex：
 *
 *   com.tencent.wglogin.authsuite.c#a(Activity, a)
 *     → new GetWXServerTicketProtocol().post(…)            // /go/auth/get_sdk_ticket
 *     → signature = f.a("appid=" + appid + "&noncestr=" + noncestr +
 *                       "&sdk_ticket=" + ticket + "&timestamp=" + timestamp)
 *     → DiffDevOAuthFactory.getDiffDevOAuth()
 *         .auth(appid, "snsapi_userinfo", noncestr, timestamp, signature, listener)
 *         … 内部就是 sdk/qrconnect 出码 + long.open.weixin.qq.com 轮询
 *
 * appid 来自 com.tencent.mlol.startup.afterlaunch.h（掌瓦分支）：
 *   `com.tencent.share.core.c.a("wxcbb49f1f39656c2a", "http://app.val.qq.com")`
 *
 * ## 实测
 *
 *   ticket  → 128 字符
 *   出码    → errcode=0，appname 回显「掌上无畏契约」，qrcodebase64 是 JPEG（62KB）
 *   轮询    → {"wx_errcode":408, "wx_code":""}（未扫码）
 */

import crypto from 'node:crypto'

export const MVAL_BASE = 'https://app.mval.qq.com'
export const SDK_TICKET_API = `${MVAL_BASE}/go/auth/get_sdk_ticket`
export const QR_CONNECT = 'https://open.weixin.qq.com/connect/sdk/qrconnect'
export const QR_POLL = 'https://long.open.weixin.qq.com/connect/l/qrconnect'

export const UA_MVAL = 'mval/2.4.0.10053 Channel/10068 Manufacturer/Xiaomi '
  + 'Mozilla/5.0 (Linux; Android 14; 23117RK66C Build/V417IR; wv) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
  + 'Chrome/101.0.4951.61 Mobile Safari/537.36'

/**
 * 掌瓦自己的微信开放平台 appid。
 *
 * ⚠️ 别换成 `wx5a4a8ac0fd48303a` —— 那是**掌上英雄联盟**的（同一个 dex 里，
 *    ShareInitTask 按 `c.g()` 分支选）。用错 appid 换票一定 40029，
 *    因为微信的 code 按 appid 隔离。
 */
export const WX_APPID_MVAL = 'wxcbb49f1f39656c2a'

const TIMEOUT = Number(process.env.LOGIN_TIMEOUT) || 15000
const DEVICE = process.env.MVAL_DEVICE || '23117RK66C'
const ZONE = process.env.MVAL_ZONE || 'agame'

function fail (message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 服务端偶尔把响应体拼两遍 */
function parseEnvelope (text) {
  try { return JSON.parse(text) } catch {
    const i = text.indexOf('}{')
    if (i > 0) { try { return JSON.parse(text.slice(0, i + 1)) } catch {} }
    return null
  }
}

/**
 * 1) 取 sdk_ticket。
 * 接口是 POST + JSON body，GET 会 404（不是随便能糊的）。
 */
export async function getSdkTicket ({ zone = ZONE } = {}) {
  let res
  try {
    res = await fetch(`${SDK_TICKET_API}?source_game_zone=${zone}&game_zone=${zone}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA_MVAL,
        // 取票是「未登录」态的动作，带上登录 cookie 会被判非法
        Cookie: 'clientType=9; openid=null; access_token=null'
      },
      body: JSON.stringify({
        clienttype: 9,
        config_params: { client_dev_name: DEVICE, lang_type: 0 }
      })
    })
  } catch (error) {
    throw fail(`连不上掌瓦取票接口：${error.message}`, 'UPSTREAM')
  }

  const json = parseEnvelope(await res.text())
  if (!json) throw fail('取票接口返回的不是 JSON', 'UPSTREAM')
  const ticket = json?.data?.ticket
  if (String(json.result) !== '0' || !ticket) {
    throw fail(`取 sdk_ticket 失败（result=${json.result}, msg=${json.msg || ''}）`, 'UPSTREAM')
  }
  return ticket
}

/** 2) 签名 = sha1("appid=..&noncestr=..&sdk_ticket=..&timestamp=..")，顺序不能乱 */
export function buildSignature ({ appid, noncestr, ticket, timestamp }) {
  const raw = `appid=${appid}&noncestr=${noncestr}&sdk_ticket=${ticket}&timestamp=${timestamp}`
  return {
    raw,
    signature: crypto.createHash('sha1').update(raw).digest('hex')
  }
}

/**
 * 3) 出码。
 * @returns {{ uuid, appName, qr }} qr 是可直接塞进 <img src> 的 data URI
 */
export async function requestQrCode ({
  appid = process.env.WX_APPID || WX_APPID_MVAL,
  scope = 'snsapi_userinfo',
  ticket
} = {}) {
  const sdkTicket = ticket || await getSdkTicket()
  // App 里 noncestr 是 e.a(6) —— 一个随机串。微信只要求「和签名里的一致」，格式不限
  const noncestr = crypto.randomBytes(8).toString('hex')
  const timestamp = String(Math.floor(Date.now() / 1000))
  const { signature } = buildSignature({ appid, noncestr, ticket: sdkTicket, timestamp })

  const url = new URL(QR_CONNECT)
  url.searchParams.set('appid', appid)
  url.searchParams.set('noncestr', noncestr)
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('scope', scope)
  url.searchParams.set('signature', signature)

  let res
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': UA_MVAL }
    })
  } catch (error) {
    throw fail(`连不上微信出码接口：${error.message}`, 'UPSTREAM')
  }

  const text = await res.text()
  const json = parseEnvelope(text)
  if (!json) throw fail(`微信返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, 'UPSTREAM')

  if (json.errcode !== 0 || !json.uuid) {
    // 40001 = 签名不对 / ticket 过期（ticket 有有效期，几分钟）
    const hint = json.errcode === 40001
      ? '：sdk_ticket 无效或已过期，或签名串顺序不对'
      : ''
    throw fail(`微信不给出码（errcode=${json.errcode} ${json.errmsg || ''}）${hint}`, 'UPSTREAM')
  }

  const b64 = json.qrcode?.qrcodebase64 || ''
  if (!b64) throw fail('微信给了 uuid 但没给二维码图片', 'UPSTREAM')

  return {
    uuid: json.uuid,
    appName: json.appname || '掌上无畏契约',
    // JPEG（base64 以 /9j/ 开头），不是 PNG
    qr: `data:image/jpeg;base64,${b64}`,
    sdkTicket: sdkTicket
  }
}

/**
 * 4) 轮询一次。
 *
 * 返回 `{ status, code?, raw }`：
 *   408 未扫 / 404 已扫待确认 / 405 已确认且**带 wx_code** / 402 过期 / 403 取消
 *
 * ⚠️ 405 才是拿 code 的那一刻。404 只是「手机扫了但还没点确认」。
 */
export async function pollQr ({ uuid, timeout = TIMEOUT } = {}) {
  if (!uuid) return { status: 'expired', message: '会话丢了 uuid' }

  const url = `${QR_POLL}?f=json&uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`
  let text = ''
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA_MVAL }
    })
    text = await res.text()
  } catch (error) {
    // 长轮询超时是常态，当「还没动静」处理，别把会话打死
    return { status: 'waiting', message: '等待扫码', transient: true }
  }

  const m = text.match(/"wx_errcode"\s*:\s*(\d+)/) || text.match(/wx_errcode=(\d+)/)
  const errcode = m ? Number(m[1]) : 0
  const code = (text.match(/"wx_code"\s*:\s*"([^"]*)"/) || text.match(/wx_code=['"]([^'"]*)['"]/) || [])[1] || ''

  switch (errcode) {
    case 408: return { status: 'waiting', message: '等待扫码', raw: text.slice(0, 160) }
    case 404: return { status: 'scanned', message: '已扫描，请在手机上点「确认登录」', raw: text.slice(0, 160) }
    case 405: {
      if (!code) return { status: 'blocked', message: '微信确认了但没给 code，重发一次指令', raw: text.slice(0, 160) }
      return { status: 'authorized', code, raw: text.slice(0, 160) }
    }
    case 402: return { status: 'expired', message: '二维码过期了，重新发一次指令' }
    case 403: return { status: 'cancelled', message: '你在手机上取消了登录' }
    default: return { status: 'waiting', message: '等待扫码', raw: text.slice(0, 160) }
  }
}

export default { getSdkTicket, buildSignature, requestQrCode, pollQr, WX_APPID_MVAL, UA_MVAL }
