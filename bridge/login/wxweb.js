/**
 * 微信网页版扫码适配器（**实验性，且与战绩无关**）。
 *
 * ## ⚠️ 先看这段，别被名字骗了
 *
 * 这个适配器登录的是「微信网页版」，拿到的是**微信自己的会话**。
 * 它调用不了 val.qq.com / api.val.qq.com 的任何接口 —— 也就是说
 * **登录成功也查不到无畏契约战绩**。
 *
 * 实测结论（2026-10，真机扫码）：
 *   · 出码、扫、确认 三步全都正常（你的号能过确认环节）
 *   · 但确认后的 `webwxnewloginpage` 没给出 skey/pass_ticket，
 *     说明微信对网页版登录的收紧已经不只是 ret=1203 那一种表现
 *
 * 那为什么还留着？因为它是**唯一一条零配置就能验证「出码→已扫→已确认」
 * 整条链路**的方式，调 UI / 调状态机时很有用（qq 适配器卡在轮询那步，
 * 走不到 confirmed）。
 *
 * 默认不注册，要跑请加 `LOGIN_EXPERIMENTAL=1`。
 *
 * ## 和 wechat.js 的区别
 *
 *   wechat.js  走开放平台「网站应用」qrconnect —— 需要已审核 AppID + 备案回调域，
 *              拿到的是 code，能换 openid（用户身份，但不含游戏数据）。
 *   wxweb.js   走网页版微信客户端那套 —— 零配置，但不是用户身份，
 *              对游戏业务没有任何用处。
 *
 * 想要「登录一次就能持续查战绩」，两条路都不对，见 bridge/login/README.md 的
 * 「掌瓦到底怎么登录」一节。
 *
 * ## 为什么要 abort 长轮询
 *
 * `mmwebwx-bin/login` 是**长轮询**接口：没有状态变化时它会把连接挂住 ~25 秒
 * 才返回 `window.code=408`。而插件侧请求超时是 20 秒（gateway.timeout），
 * 如果老老实实等它，插件那边会先 abort —— 看起来就像「网关不回话」。
 *
 * 这里的做法：上游只等 `WXWEB_POLL_BUDGET`（默认 3.5s），超时就当「还在等」返回。
 * abort 不会丢状态（状态在微信服务器上），下一次轮询接着问就行，
 * 最坏情况只是状态晚一个轮询间隔被感知。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 诊断用的响应落盘目录（已被 .gitignore 忽略） */
const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.state')

/** 网页版微信客户端内置的公开 appid，不是密钥，官方登录页里就写着 */
const APPID = process.env.WXWEB_APPID || 'wx782c26e4c19acffb'
const POLL_BUDGET = Number(process.env.WXWEB_POLL_BUDGET) || 3500
const TIMEOUT = Number(process.env.LOGIN_TIMEOUT) || 15000

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://login.weixin.qq.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

/** 拿一个 uuid（一次扫码会话的唯一标识） */
async function fetchUuid () {
  const url = 'https://login.weixin.qq.com/jslogin'
    + `?appid=${APPID}&fun=new&lang=zh_CN&_=${Date.now()}`

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: HEADERS })
  const text = await res.text()

  const uuid = text.match(/uuid\s*=\s*"([^"]+)"/)?.[1]
  const code = text.match(/code\s*=\s*(\d+)/)?.[1]

  if (code !== '200' || !uuid) {
    const error = new Error(`jslogin 没有给出 uuid（返回：${text.slice(0, 120)}）`)
    error.code = 'UPSTREAM'
    throw error
  }
  return uuid
}

export const wxwebAdapter = {
  name: 'wxweb',

  async start () {
    const uuid = await fetchUuid()

    // ⚠️ uuid 里带 `==` 结尾，**千万不要 encodeURIComponent**：
    //    实测 `?t=webwx` 配 `%3D%3D` 会返回 200 + 空 body（不报错，就是没图），
    //    用原样的 `==` 才有 40KB 的真实二维码。这个坑很难从状态码看出来。
    const qrRes = await fetch(`https://login.weixin.qq.com/qrcode/${uuid}?t=webwx`, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: HEADERS
    })
    const buf = Buffer.from(await qrRes.arrayBuffer())
    if (!buf.length) {
      const error = new Error('二维码图片为空（uuid 可能被转义了，见 wxweb.js 注释）')
      error.code = 'UPSTREAM'
      throw error
    }

    // 微信这边给的是 JPEG（虽然路径叫 qrcode），按内容判断类型别写死
    const mime = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png'

    return {
      qr: `data:${mime};base64,${buf.toString('base64')}`,
      state: { uuid }
    }
  },

  async poll (state) {
    // uuid 同样保持原样（理由见 start() 里的注释）
    const url = 'https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login'
      + `?loginicon=true&uuid=${state.uuid}`
      + `&tip=0&r=${~Date.now()}&_=${Date.now()}`

    let text = ''
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(POLL_BUDGET), headers: HEADERS })
      text = await res.text()
    } catch (error) {
      // 长轮询被我们主动 abort = 这段时间没变化，继续等
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return { status: 'waiting', message: '等待扫码（微信），用微信「扫一扫」扫一下' }
      }
      throw error
    }

    const code = text.match(/window\.code\s*=\s*(\d+)/)?.[1]

    if (code === '408' || !code) return { status: 'waiting', message: '等待扫码（微信）' }
    if (code === '201') return { status: 'scanned', message: '已扫描，请在手机上点「确认登录」' }
    if (code === '400' || code === '500') return { status: 'expired', message: '二维码已过期' }

    if (code !== '200') {
      return { status: 'waiting', message: `微信返回了未知状态（${code}）` }
    }

    // code=200：手机上已经点了确认，接着走 newloginpage 拿凭证
    let redirect = text.match(/redirect_uri\s*=\s*"([^"]+)"/)?.[1]
    if (!redirect) {
      return { status: 'blocked', message: '微信确认成功但没给 redirect_uri，可能协议变了' }
    }
    // 万一被 HTML 转义或 JS 转义过，还原回来。
    // `\/` 这种尤其要命：URL 带反斜杠时 fetch 会把它当成非法路径，
    // 最后请求到站点根目录 → 拿到一张 HTML 首页，看起来像「微信返回了网页」。
    redirect = redirect
      .replace(/&amp;/g, '&')
      .replace(/\\x26/g, '&')
      .replace(/\\\//g, '/')

    return handshake(redirect)
  }
}

/**
 * 用 redirect_uri 换 skey / wxsid / pass_ticket。
 * 这一步是「网页版微信」和「网站应用」分道扬镳的地方 —— 后者只给 code，
 * 前者直接给一整套网页会话 cookie。
 */
async function handshake (redirectUrl) {
  // 把 URL 结构打出来（ticket 打码）：一旦它是 `https:\/\/...` 这种残废 URL，
  // 一眼就能看出来 —— 请求会落到站点根目录，拿回一张 HTML 首页。
  console.log(`[wxweb] handshake url=${String(redirectUrl).replace(/ticket=[^&]+/, 'ticket=***')}`)

  let res
  try {
    // ⚠️ redirect: 'manual' 是关键。newloginpage 常常是「3xx + XML body」，
    //    默认跟随跳转的话，落到 wx.qq.com 首页 HTML，`<ret>` / `<skey>` 全丢了。
    res = await fetch(redirectUrl, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: HEADERS,
      redirect: 'manual'
    })
  } catch (error) {
    return { status: 'blocked', message: `确认后握手失败：${error.message}` }
  }

  const body = await res.text()
  const head = body.replace(/\s+/g, ' ').slice(0, 160)
  console.log(`[wxweb] newloginpage HTTP ${res.status} location=${res.headers.get('location') || '-'} body=${head || '(空)'}`)

  // 拿到 HTML 说明请求没打到真正的接口（URL 被转义 / 被风控重定向）。
  // 把完整响应存下来，出问题时能直接看微信到底想说什么。
  if (/<html[\s>]/i.test(body)) {
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '(无 title)'
    console.log(`[wxweb] 返回的是网页而不是 XML，title=${title}`)
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(path.join(STATE_DIR, 'wxweb-last.html'), body, 'utf8')
      console.log('[wxweb] 完整响应已存到 bridge/.state/wxweb-last.html')
    } catch {}
  }

  // 凭证有两种给法：XML 里、或者 Set-Cookie 里。两边都收，同名以 XML 为准。
  const pick = tag => body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] || ''
  const cookies = {
    skey: pick('skey'),
    wxsid: pick('wxsid'),
    wxuin: pick('wxuin'),
    pass_ticket: pick('pass_ticket')
  }
  for (const line of res.headers.getSetCookie?.() || []) {
    const pair = line.split(';')[0]
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    if (!cookies[key]) cookies[key] = pair.slice(idx + 1).trim()
  }

  const retMatch = body.match(/<ret>(-?\d+)<\/ret>/)
  const message = (body.match(/<message>([\s\S]*?)<\/message>/)?.[1] || '').trim()

  // ret 非 0：微信明确拒绝（1203 = 该号不允许登录网页版）
  if (retMatch && retMatch[1] !== '0') {
    const ret = retMatch[1]
    const friendly = ret === '1203'
      ? `微信拒绝了这个号登录网页版：${message || '为了你的帐号安全，此微信号不能登录网页版微信'}`
      : `微信拒绝了这次登录（ret=${ret}${message ? `：${message}` : ''}）`
    return { status: 'blocked', message: friendly }
  }

  // 没有 <ret> 时，只有「真拿到了 skey / pass_ticket」才敢算成功。
  // ⚠️ 之前这里是 `ret = match || '0'` 直接放行 —— 结果页面显示「登录成功」，
  //    实际凭证全是空串，等于把用户骗了一遍。宁可报失败也不能报假成功。
  if (!cookies.skey && !cookies.pass_ticket) {
    return {
      status: 'blocked',
      message: retMatch
        ? '微信返回 ret=0 但没下发会话凭证，这个号可能被限制网页版登录'
        : `确认成功但没换到凭证（HTTP ${res.status}，响应开头：${head || '空'}）`
    }
  }

  return {
    status: 'confirmed',
    message: '登录成功（网页版微信）',
    profile: { nickname: '', uin: cookies.wxuin },
    cookies
  }
}

export default wxwebAdapter
