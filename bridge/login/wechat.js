/**
 * 微信扫码登录适配器（微信开放平台「网站应用」的 qrconnect）。
 *
 * ## 前置条件（这个不是代码能绕过的）
 *
 * 必须有一个**已通过审核的网站应用**：
 *   · 在 open.weixin.qq.com 注册「网站应用」，拿到 AppID / AppSecret；
 *   · 配置**授权回调域**（域名要备案），回调地址的域名必须与之一致。
 * 也就是说：想用微信扫码，要么你自己有备案域名 + 网站应用，要么用掌瓦/官网
 * 自己那套 appid（得抓包拿到，且通常绑死了它们的回调域，成功后会跳到它们的页面）。
 *
 * 没有 appid 时本适配器会直接返回 NOT_CONFIGURED，不会让用户白扫码。
 *
 * ## 流程
 *
 *   1. GET /connect/qrconnect?appid=..&redirect_uri=..&scope=snsapi_login
 *      → 返回 HTML，里面嵌着 uuid
 *   2. 二维码图片：https://open.weixin.qq.com/connect/qrcode/{uuid}
 *   3. 轮询：https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=..&_=ts
 *      → window.wx_errcode=408(未扫) / 404(已扫待确认) / 405(已确认,带wx_code) / 402(过期)
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT = Number(process.env.LOGIN_TIMEOUT) || 15000

const APPID = process.env.WX_APPID || ''
const SECRET = process.env.WX_SECRET || ''
const REDIRECT = process.env.WX_REDIRECT || ''

export const wechatAdapter = {
  name: 'wx',

  async start () {
    if (!APPID || !REDIRECT) {
      const error = new Error(
        '未配置微信网站应用：请设置环境变量 WX_APPID 与 WX_REDIRECT（授权回调域要在微信开放平台登记过）。'
      )
      error.code = 'NOT_CONFIGURED'
      throw error
    }

    const url = 'https://open.weixin.qq.com/connect/qrconnect'
      + `?appid=${encodeURIComponent(APPID)}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + '&response_type=code&scope=snsapi_login&state=valorant'
      + '#wechat_redirect'

    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }
    })
    const html = await res.text()

    // 页面里形如：var uuid = "0a1b2c...";
    const uuid = html.match(/uuid\s*=\s*["']([0-9a-zA-Z_-]+)["']/)?.[1]
      || html.match(/\/connect\/qrcode\/([0-9a-zA-Z_-]+)/)?.[1]

    if (!uuid) {
      const error = new Error('没能从 qrconnect 页面解析出 uuid（可能 appid 未通过审核或回调域不匹配）')
      error.code = 'UPSTREAM'
      throw error
    }

    const qrRes = await fetch(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/' }
    })
    const buf = Buffer.from(await qrRes.arrayBuffer())
    if (!buf.length) {
      const error = new Error('二维码图片为空')
      error.code = 'UPSTREAM'
      throw error
    }

    return {
      qr: `data:image/jpeg;base64,${buf.toString('base64')}`,
      state: { uuid }
    }
  },

  async poll (state) {
    const url = `https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(state.uuid)}&_=${Date.now()}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/' }
    })
    const text = await res.text()

    if (text.includes('wx_errcode=405')) {
      const code = text.match(/wx_code=['"]([^'"]+)['"]/)?.[1] || ''
      // 微信侧只给 code，还要拿 AppSecret 去换 access_token/openid，这步放在 provider 里做
      return {
        status: 'confirmed',
        message: '登录成功',
        profile: { openid: '', nickname: '' },
        cookies: { code, appid: APPID, secret: SECRET ? '已配置' : '' }
      }
    }
    if (text.includes('wx_errcode=404')) return { status: 'scanned', message: '已扫描，请在手机上确认' }
    if (text.includes('wx_errcode=402')) return { status: 'expired', message: '二维码已过期' }

    return { status: 'waiting', message: '等待扫码' }
  }
}

export default wechatAdapter
