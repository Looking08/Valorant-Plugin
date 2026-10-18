/**
 * QQ 扫码登录适配器（腾讯 ptlogin2 那套）。
 *
 * 流程就是网页端 QQ 登录的三步，不是什么黑科技：
 *   1. `xui.ptlogin2.qq.com/cgi-bin/xlogin` → 拿 `pt_login_sig` cookie
 *   2. `ssl.ptlogin2.qq.com/ptqrshow`        → 拿二维码 PNG + `qrsig` cookie
 *   3. `ssl.ptlogin2.qq.com/ptqrlogin`       → 每 2s 轮询，返回 ptuiCB(...)
 *
 * 状态码（ptuiCB 第一个参数）：
 *   66 未失效（还没扫）  67 已扫描待确认  0 登录成功  65 已失效
 *
 * ⚠️⚠️ 实测结论（2026-10，本机验证）：第 1、2 步稳定可用，能拿到真二维码；
 *    第 3 步在**非浏览器**环境经常返回 **HTTP 200 + 空 body**（前置网关是
 *    TAPISIX，疑似按 TLS 指纹/风控静默丢弃）。所以这里做了降级：
 *    连续 N 次空响应就返回 blocked，并给出提示，而不是让用户对着二维码干等。
 *    真要跑通，两条路：① 用浏览器（chromium）打开 xlogin 页面走真实 UA 栈；
 *    ② 直接抓一份真实的 ptqrlogin 请求头贴进来。二者都能接进这个 adapter。
 *
 * 参数说明：
 *   appid=716027609 / daid=383 是腾讯游戏站点通用的第三方登录 appid，
 *   换站点只要改 `sUrl`（登录成功后的落地页）。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const APPID = process.env.QQ_APPID || '716027609'
const DAID = process.env.QQ_DAID || '383'
/** 登录成功后的落地页，默认指到无畏契约官网 */
const S_URL = process.env.QQ_S_URL || 'https://val.qq.com/main.html'
const TIMEOUT = Number(process.env.LOGIN_TIMEOUT) || 15000

/** 腾讯的 hash33：ptqrtoken = hash33(qrsig) */
function hash33 (input) {
  let hash = 0
  for (let i = 0; i < String(input).length; i++) {
    hash += (hash << 5) + String(input).charCodeAt(i)
  }
  return hash & 0x7FFFFFFF
}

/** 从 Set-Cookie 头里抠某个 cookie 的值 */
function pickCookie (setCookies, name) {
  for (const line of setCookies || []) {
    const m = String(line).match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
    if (m) return m[1]
    const head = String(line).match(new RegExp(`^${name}=([^;]+)`))
    if (head) return head[1]
  }
  return ''
}

async function fetchWithCookie (url, cookie, referer) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(referer ? { Referer: referer } : {})
    }
  })
  return res
}

export const qqAdapter = {
  name: 'qq',

  async start () {
    // 1) xlogin 拿 pt_login_sig —— 少了它，后面轮询会被当成无效会话
    const sUrlEncoded = encodeURIComponent(S_URL)
    const xloginUrl = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin'
      + `?appid=${APPID}&daid=${DAID}&style=33&hide_title_bar=1&low_login=0`
      + '&qlogin_auto_login=1&no_verifyimg=1&link_target=blank'
      + `&pt_3rd_aid=0&target=self&s_url=${sUrlEncoded}`

    const xlogin = await fetchWithCookie(xloginUrl, '', 'https://val.qq.com/')
    const xCookies = xlogin.headers.getSetCookie?.() || []
    const loginSig = pickCookie(xCookies, 'pt_login_sig')
    const cookie = xCookies.map(c => c.split(';')[0]).join('; ')

    // 2) ptqrshow 拿二维码
    const qrUrl = 'https://ssl.ptlogin2.qq.com/ptqrshow'
      + `?appid=${APPID}&e=2&l=M&s=3&d=72&v=4&t=${Date.now()}&daid=${DAID}&pt_3rd_aid=0`

    const qrRes = await fetchWithCookie(qrUrl, cookie, 'https://xui.ptlogin2.qq.com/')
    const qrCookies = qrRes.headers.getSetCookie?.() || []
    const qrsig = pickCookie(qrCookies, 'qrsig')
    if (!qrsig) {
      const error = new Error('ptqrshow 没返回 qrsig，可能被风控了')
      error.code = 'UPSTREAM'
      throw error
    }

    const buf = Buffer.from(await qrRes.arrayBuffer())
    if (!buf.length) {
      const error = new Error('ptqrshow 返回了空图片')
      error.code = 'UPSTREAM'
      throw error
    }

    return {
      qr: `data:image/png;base64,${buf.toString('base64')}`,
      state: {
        qrsig,
        loginSig,
        cookie: [...xCookies, ...qrCookies].map(c => c.split(';')[0]).join('; '),
        ptqrtoken: hash33(qrsig)
      }
    }
  },

  async poll (state) {
    const url = 'https://ssl.ptlogin2.qq.com/ptqrlogin'
      + `?u1=${encodeURIComponent(S_URL)}`
      + `&ptqrtoken=${state.ptqrtoken}`
      + '&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052'
      + `&action=0-0-${Date.now()}&js_ver=20102616&js_type=1`
      + `&login_sig=${encodeURIComponent(state.loginSig || '')}`
      + `&pt_uistyle=40&aid=${APPID}&daid=${DAID}&pt_3rd_aid=0&`

    const res = await fetchWithCookie(url, state.cookie, 'https://xui.ptlogin2.qq.com/')
    const text = (await res.text()).trim()

    // 空 body：见文件头的说明，这是被前置网关丢掉了
    if (!text) {
      return {
        status: 'waiting',
        upstreamEmpty: true,
        hint: 'ptqrlogin 返回空响应（被风控拦了）。解决办法：用浏览器方案走真实 TLS 栈，或把抓到的 ptqrlogin 请求头填进 bridge/login/qq.js。'
      }
    }

    const m = text.match(/ptuiCB\('(\d+)','(\d+)','([^']*)','(\d+)','([^']*)','([^']*)'\)/)
    if (!m) {
      return { status: 'waiting', message: '上游返回了意料之外的格式' }
    }

    const [, code, , redirect, , message, nickname] = m

    switch (code) {
      case '66':
        return { status: 'waiting', message: '等待扫码' }
      case '67':
        return { status: 'scanned', message: '已扫描，请在手机上确认登录' }
      case '65':
        return { status: 'expired', message: '二维码已失效，重新发指令' }
      case '0': {
        // 成功：redirect 里带着 uin / skey，落地页还会给 p_skey
        const parsed = new URL(redirect)
        const cookies = {}
        for (const [k, v] of parsed.searchParams) cookies[k] = v
        return {
          status: 'confirmed',
          message: `登录成功${nickname ? `：${nickname}` : ''}`,
          profile: { nickname: decodeURIComponent(nickname || ''), uin: cookies.uin || '' },
          cookies: {
            ...cookies,
            // uin 去掉前导 o，才是纯 QQ 号
            uin: String(cookies.uin || '').replace(/^o0*/, ''),
            skey: cookies.skey || '',
            redirect
          }
        }
      }
      default:
        return { status: 'waiting', message: message || `未知状态 ${code}` }
    }
  }
}

export default qqAdapter
