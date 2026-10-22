/**
 * 掌瓦（app.mval.qq.com）微信登录凭证交换。
 *
 * ## 字段从哪来的
 *
 * 从「掌上无畏契约 2.9.0」`classes8.dex` 里扒出来的，类名与字段名如下
 * （Gson 默认用字段名当 JSON key，所以这就是服务端的真实契约）：
 *
 *   LoginByWXProtocol$Params
 *     clienttype       int
 *     config_params    { client_dev_name: String, lang_type: int }
 *     login_info       { appid: String, code: String, wx_info_type: int, check_third_type: int }
 *     mappid           int
 *     mcode            String
 *
 *   LoginByQQProtocol$Params
 *     login_info       { appid: long, openid: String, qq_info_type: int, sig: String, uin: long }
 *
 * QQ 那条在 `qq.js`（已经有了，且本节只补微信）。
 *
 * ## 一条重要的实测结论
 *
 * 拿假 code 打这个接口，服务端返回微信的标准错误码 40029（invalid code）——
 * 说明 **AppSecret 在掌瓦服务端**，它替我们完成 code→openid 的交换。
 * 好消息：我们不需要 AppSecret。
 * 坏消息：code 必须是由 `appid` 这个应用**签发**的，微信按 appid 隔离 code。
 * 用自建网站应用的 appid 扫码得到的 code 传进来只会得到 40029。
 *
 * 而「掌瓦 appid 签发的 code」现在是能自己拿到的 —— 走微信**扫码 SDK**
 * （`/connect/sdk/qrconnect`），出码和轮询都在 `wxqr.js`，不需要白名单也不需要浏览器。
 * 本文件只负责最后那一步：把这个 code 交给掌瓦换成登录态。
 */

export const MVAL_BASE = 'https://app.mval.qq.com'
export const WX_LOGIN = `${MVAL_BASE}/go/auth/login_by_wechat`
export const ROLE_API = `${MVAL_BASE}/go/account/get_main_role_raw`

/** 掌瓦客户端 UA，服务端会看它 */
export const UA_MVAL = 'mval/2.4.0.10053 Channel/10068 Manufacturer/Xiaomi '
  + 'Mozilla/5.0 (Linux; Android 14; 23117RK66C Build/V417IR; wv) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
  + 'Chrome/101.0.4951.61 Mobile Safari/537.36'

/** 掌瓦自己的微信 appid（APK: ShareInitTask 的 `c.g()` 分支），排第一 */
export const WX_APPIDS = ['wxcbb49f1f39656c2a', 'wx5a4a8ac0fd48303a']

const DEFAULT_MCODE = process.env.MVAL_MCODE || '132f0a77d34402abc8463d60100011d19b0e'
const DEFAULT_DEVICE = process.env.MVAL_DEVICE || '23117RK66C'
const TIMEOUT = Number(process.env.LOGIN_TIMEOUT) || 15000

export function fail (message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 服务端偶尔把响应体拼两遍，容错一下 */
function parseEnvelope (text) {
  try { return JSON.parse(text) } catch {
    const i = text.indexOf('}{')
    if (i > 0) { try { return JSON.parse(text.slice(0, i + 1)) } catch {} }
    return null
  }
}

/** 把 errMsg 里的上游 ret 码翻译成人话 */
export function explainUpstream (json) {
  const detail = String(json?.errMsg || json?.err_msg || json?.msg || '')
  const ret = (detail.match(/ret=(\d+)/) || [])[1] || ''
  const wxCode = (detail.match(/code:(\d+)/) || [])[1] || ''
  if (wxCode === '40029' || ret === '40029') {
    return {
      ret: '40029',
      text: '微信 code 无效：已用过、已过期，或者不是这个 appid 签发的（微信按 appid 隔离 code）'
    }
  }
  if (ret === '10104') {
    return { ret: '10104', text: 'QQ token 校验不过：过期/被顶号，或不是 appid 102061775 签发的' }
  }
  return { ret, text: json?.msg || detail || '没有说明原因' }
}

/**
 * code → 掌瓦凭证。
 *
 * @param {object} o
 * @param {string} o.code          微信授权 code（必须由 appid 签发）
 * @param {string} [o.appid]       签发这个 code 的 appid，默认取 WX_APPID 环境变量
 * @param {number} [o.wxInfoType]  默认 1（APK 里 loginByWX 传的就是 1）
 * @param {number} [o.checkThirdType] 默认 1（`wglogin.d#a(SsoLicense…)` 里写死的 1）
 * @param {string} [o.zone]        agame（端游）/ codev（手游），默认 agame，与 qq.js 一致
 */
export async function exchangeWX ({
  code,
  appid = process.env.WX_APPID || WX_APPIDS[0],
  wxInfoType = 1,
  checkThirdType = 1,
  zone = 'agame',
  mcode = DEFAULT_MCODE,
  device = DEFAULT_DEVICE,
  clienttype = 9,
  mappid = 10200
} = {}) {
  if (!code) throw fail('缺少微信 code', 'BAD_REQUEST')

  const url = `${WX_LOGIN}?source_game_zone=${zone}&game_zone=${zone}`
  const body = {
    clienttype,
    config_params: { client_dev_name: device, lang_type: 0 },
    login_info: {
      appid: String(appid),
      check_third_type: Number(checkThirdType),
      code: String(code),
      wx_info_type: Number(wxInfoType)
    },
    mappid: Number(mappid),
    mcode
  }

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA_MVAL,
        // 换票这一步要「未登录」的 cookie，带上登录态反而会被拒
        Cookie: 'clientType=9; openid=null; access_token=null'
      },
      body: JSON.stringify(body)
    })
  } catch (error) {
    throw fail(`连不上掌瓦登录接口：${error.message}`, 'UPSTREAM')
  }

  const json = parseEnvelope(await res.text())
  if (!json) throw fail('掌瓦返回的不是 JSON，换凭证失败', 'UPSTREAM')
  if (String(json.result) !== '0') {
    const why = explainUpstream(json)
    throw fail(`换掌瓦凭证失败（result=${json.result}${why.ret ? `, ret=${why.ret}` : ''}）：${why.text}`, 'UPSTREAM_AUTH')
  }

  const info = json.data?.login_info || {}
  if (!info.user_id) throw fail('掌瓦没返回 user_id，换凭证没成功', 'UPSTREAM_AUTH')
  return info
}

/**
 * 微信登录态的 cookie 行。
 * 跟 QQ 那份的差别只有 acctype：微信侧是 wx。
 */
export function buildCookieWX ({ openid, accessToken, userId, tid, appid = process.env.WX_APPID || WX_APPIDS[0] }) {
  return [
    'clientType=9',
    `appid=${appid}`,
    'acctype=wx',
    `openid=${openid}`,
    `access_token=${accessToken}`,
    `userId=${userId}`,
    'accountType=5',
    `tid=${tid}`
  ].join('; ')
}

export default { exchangeWX, buildCookieWX, explainUpstream, UA_MVAL, WX_APPIDS }
