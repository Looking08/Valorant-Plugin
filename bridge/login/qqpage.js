/**
 * QQ 扫码登录 —— 页面式授权（真浏览器跑）。
 *
 * ## 为什么不自己追 302
 *
 * 纯 HTTP 版的 `qq.js` 在扫码成功后要自己跟 `check_sig` 那条 302 链，
 * 结果卡在 `ptlogin4.openmobile.qq.com`（实测四个公共 DNS 全指 0.0.0.1）。
 * 这条路再怎么改参数都没用 —— **主机没了**。
 *
 * 换成让浏览器打开授权页，情况就不一样：页面里的 JS 自己按官方逻辑完成跳转，
 * 我们只在旁边听三处信号，哪个先响算哪个：
 *
 *   1. `page.on('request')`     —— 拦 `auth://tauth.qq.com/…`（token 在 `#` 后面）
 *   2. `page.on('framenavigated')` —— 同上，导航不一定走 request
 *   3. 轮询 `location.href`      —— 兜底，防上面两个都没触发
 *
 * 另外还加了一层保险：一旦发现浏览器要去访问那几台黑洞主机，就地 **abort**，
 * 把同一个 path/query 改投到活着的 `ptlogin4.qq.com` 集群（它认同一套 sigx），
 * 相当于给官方那条死链接上一条旁路。
 *
 * ## 回调里没有 openid
 *
 * `response_type=token` 的回调只有 `access_token` / `pay_token`，
 * openid 要另外拿 `graph.qq.com/oauth2.0/me` 换。这一步是纯 HTTP，很稳。
 *
 * 参考实现：`PUBG-Helper-Plugin/utils/qqPageLogin.js`（同样思路，营地版）。
 */

import { openPage, touchBrowser } from './browser.js'
import { parseTokenParams, resolveCheckSig } from './qq.js'

/** 掌瓦的 QQ 互联 appid（= APK 里的 openqq_appid，见 ShareInitTask） */
const QQ_APPID = process.env.QQ_APPID || '102061775'

const AUTHORIZE = 'https://openmobile.qq.com/oauth2.0/m_authorize'

/**
 * 手机 UA，末尾那截 `tencent_game_emulator` 是腾讯自己的模拟器标识。
 * 换成桌面 UA 会拿到「请用手机 QQ 扫码」的空白页，出不了码。
 */
const QR_UA = 'Mozilla/5.0 (Linux; Android 15; V2366GA Build/V417IR; wv) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
  + 'Chrome/110.0.5481.154 Safari/537.36 tencent_game_emulator'

/** 出码超时 / 等扫码超时 */
const QR_TIMEOUT = Number(process.env.QQ_QR_TIMEOUT) || 45 * 1000
const SCAN_TIMEOUT = Number(process.env.QQ_SCAN_TIMEOUT) || 150 * 1000

/** 这几台主机被 DNS 黑洞，浏览器也解析不了，必须改投 */
const BLACKHOLE = new Set([
  'ptlogin4.openmobile.qq.com',
  'ptlogin4.graph.qq.com',
  'ptlogin4.web.qq.com'
])

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

/** 授权页地址。`style=qr` 才是二维码版式，`response_type=token` 才走 fragment 回调 */
export function buildAuthorizeUrl ({ appid = QQ_APPID } = {}) {
  const qs = new URLSearchParams({
    client_id: appid,
    scope: 'all',
    redirect_uri: 'auth://tauth.qq.com/',
    response_type: 'token',
    style: 'qr'
  })
  return `${AUTHORIZE}?${qs}`
}

function hostOf (url) {
  try { return new URL(url).hostname } catch { return '' }
}

function isBlackholed (url) {
  return BLACKHOLE.has(hostOf(url))
}

/** `auth://tauth.qq.com/#access_token=…` → { access_token, pay_token } */
export function parseAuthCallback (url) {
  if (!url) return null
  if (!url.startsWith('auth://') && !url.includes('tauth.qq.com')) return null
  const parsed = parseTokenParams(url)
  if (!parsed?.access_token) return null
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : ''
  const pay = (new URLSearchParams(hash).get('pay_token')) || ''
  return { access_token: parsed.access_token, pay_token: pay }
}

/** access_token → openid（QQ 开放平台标准接口，回调里拿不到这个） */
export async function fetchOpenid (accessToken, ua = QR_UA) {
  const res = await fetch(
    'https://graph.qq.com/oauth2.0/me?access_token=' + encodeURIComponent(accessToken) + '&fmt=json',
    { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15000) }
  )
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text)
    if (json?.openid) return String(json.openid)
  } catch {
    // 老版本会回 `callback( {"openid":"…"} );` 这种 JSONP，抠一下
    const m = text.match(/"openid"\s*:\s*"([^"]+)"/)
    if (m) return m[1]
  }
  return ''
}

/**
 * 开一个扫码会话。
 * @returns {Promise<{qr:string, waitForCallback:Function, close:Function, appName:string}>}
 */
export async function createQQPageSession ({ appid = QQ_APPID, onLog = () => {} } = {}) {
  const page = await openPage({
    userAgent: QR_UA,
    viewport: { width: 420, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  })
  if (!page) {
    const error = new Error('没有可用的浏览器，页面式授权起不来')
    error.code = 'NO_BROWSER'
    throw error
  }

  let closed = false
  let token = null
  let pendingCheckSig = ''
  let resolveToken
  const done = new Promise(r => { resolveToken = r })

  const settle = (t, from) => {
    if (!t || token) return
    token = t
    onLog(`拿到授权凭证（${from}）`)
    resolveToken(t)
  }

  // ---- 三处信号 ----
  page.on('request', (req) => {
    const url = req.url()
    const cb = parseAuthCallback(url)
    if (cb) return settle(cb, 'request')
    if (isBlackholed(url)) {
      // 浏览器会在这台上失败；记下 URL 交给 Node 侧改投旁路
      pendingCheckSig = pendingCheckSig || url
      onLog(`发现黑洞主机请求，改投旁路：${hostOf(url)}`)
      req.abort().catch(() => {})
    }
  })
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    const cb = parseAuthCallback(frame.url())
    if (cb) settle(cb, 'framenavigated')
  })

  /**
   * 把页面自己发给 ptqrlogin 的轮询结果抄一份。
   *
   * 这是判断「码到底死没死」的唯一地面真相 —— 页面用它自己的 cookie、自己的
   * 请求头去问，手机扫码时 QQ 也是拿同一套东西比对。手机提示「已过期」时，
   * 到底是码本身被拒（68）、还是被扫前就超时（65）、还是页面根本没在轮询
   * （一条都没有），看这里就分得清，不用再猜。
   */
  page.on('response', (res) => {
    const url = res.url()
    if (!url.includes('ptqrlogin')) return
    res.text().then((text) => {
      const t = String(text || '').trim()
      const code = /ptuiCB\('(\d+)'/.exec(t)?.[1] || ''
      lastPoll = { code, at: Date.now() }
      onLog(`ptqrlogin → 码 ${code || '(空)'}${code === '68' ? '（本次登录已被拒绝，页面通常会自己换一张）' : ''}`)
      if (process.env.LOGIN_DEBUG === '1' && t) onLog(`   ${t.slice(0, 120)}`)
    }).catch(() => {})
  })

  /**
   * 把页面自己收到的二维码图片原样留下 —— 这是**唯一不会有版本错位**的取码方式。
   *
   * 踩过的坑：`ptqrshow` 同一个 URL 再请求一次会回一张 386 B 的占位图（不是二维码），
   * 所以「回源拿原图」这条路在 QQ 这儿是走不通的；而截图拿到的是**画面上那张**，
   * 页面换码瞬间就可能还是旧的 —— 用户扫到旧码，手机就提示「登录失败，二维码已过期」。
   * 直接从响应里攒最新那张真图，问题从根上没了。
   */
  let lastQR = { at: 0, buf: null, url: '' }
  /** 页面最近一次轮询拿到的码：66 未扫 / 67 待确认 / 65 过期 / 68 被拒 / 0 成功 */
  let lastPoll = { code: '', at: 0 }

  /** PNG / JPEG 的魔数 —— 用它判断「这是不是一张真图」，别看体积 */
  const isImage = (buf) => {
    if (!buf || buf.length < 200) return false
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    const jpg = buf[0] === 0xff && buf[1] === 0xd8
    return png || jpg
  }

  page.on('response', (res) => {
    const u = res.url()
    if (!u.includes('ptqrshow')) return
    res.buffer().then((buf) => {
      /**
       * ⚠️ 别用体积判断真假图：QQ 的 264×264 二维码 PNG 只有 ~380 B
       * （纯黑白、无静区，压得极狠）。早先按 <2000B 当占位图丢掉，
       * 结果只能退回截图，而截图是**画面上那张**——页面换过码就是旧的，
       * 用户扫旧码 → 手机提示「登录失败，二维码已过期」。
       */
      if (isImage(buf)) {
        lastQR = { at: Date.now(), buf: Buffer.from(buf), url: u }
        onLog(`ptqrshow 收到真图 ${buf.length}B（码 ${currentPoll()}）`)
      } else {
        onLog(`ptqrshow 返回 ${buf?.length || 0}B（不是图片，丢掉）`)
      }
    }).catch(() => {})
  })

  const currentPoll = () => lastPoll.code || '?'

  const close = async () => {
    if (closed) return
    closed = true
    try { await page.close() } catch {}
  }

  try {
    const url = buildAuthorizeUrl({ appid })
    onLog(`打开授权页：${url.replace(/client_id=\d+/, 'client_id=***')}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: QR_TIMEOUT })
    touchBrowser()

    // 等二维码元素渲染出来（页面是 JS 画的，img 的 src 稍后才挂上）
    const waitBox = async () => {
      const deadline = Date.now() + QR_TIMEOUT
      while (Date.now() < deadline) {
        const box = await page.evaluate(() => {
          // 掌瓦这条授权链的真码是 `#qrimg`（src 指向 xui 的 ptqrshow）。
          // 前面几个是历史版式/兜底，别删 —— 官方换皮时还得靠它们。
          const sels = [
            '#qrimg', 'img#qrimg', 'img[src*="ptqrshow"]',
            '#qrlogin_img', '.qrlogin_img', 'img[src*="qrcode"]',
            'canvas#qrlogin_canvas', '.qrlogin canvas', 'img[alt*="二维码"]'
          ]
          for (const s of sels) {
            const el = document.querySelector(s)
            if (!el) continue
            const r = el.getBoundingClientRect()
            if (r.width > 40 && r.height > 40) {
              return { x: r.x, y: r.y, width: r.width, height: r.height }
            }
          }
          return null
        }).catch(() => null)
        if (box) return box
        await sleep(700)
      }
      return null
    }

    /**
     * 页面当前在说什么。
     * QQ 的码过期后页面会把图盖上「二维码已失效」并给个刷新按钮，
     * 这句文案是判断「码还活着吗」的唯一可靠信号 —— 必须能读出来。
     */
    const pageText = () => page.evaluate(
      () => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300)
    ).catch(() => '')

    /**
     * 取一次二维码，优先级从高到低：
     *
     * ① **页面自己收到的原图**（`lastQR`）——264×264、无缩放、随页面换码自动更新。
     *    这是唯一不会错位的一路。
     * ② 截图 —— 兜底。注意它拿到的是「画面上那张」，页面刚换过码时可能是旧的。
     *
     * ❌ 已经删掉的第三种：拿 cookie 去 `ptqrshow` 回源。实测同一条 URL 再请求一次
     *    QQ 只回 ~390 B 的占位图（不是二维码），既拿不到原图，还会把「真图」判成失败。
     */
    let qrSrc = ''
    const captureQR = async ({ why = 'first' } = {}) => {
      // ① 页面自己收到的原图最可信
      if (lastQR.buf && Date.now() - lastQR.at < 60 * 1000) {
        const age = Math.round((Date.now() - lastQR.at) / 1000)
        onLog(`取码(${why})：用页面原图 ${lastQR.buf.length}B（${age}s 前收到，当前轮询码 ${currentPoll()}）`)
        return `data:image/png;base64,${lastQR.buf.toString('base64')}`
      }

      const box = await waitBox()
      if (!box) {
        throw Object.assign(
          new Error(`QQ 授权页没出二维码（页面提示：${await pageText()}）`),
          { code: 'NO_QR' }
        )
      }

      let dataUri = ''
      let how = 'canvas'
      qrSrc = await page.evaluate(() => {
        const el = document.querySelector('#qrimg, img[src*="ptqrshow"], canvas#qrlogin_canvas')
        if (!el) return ''
        if (el.tagName === 'CANVAS') return el.toDataURL('image/png')
        const raw = el.currentSrc || el.src || el.getAttribute('data-src') || ''
        try { return new URL(raw, location.href).toString() } catch { return raw }
      }).catch(() => '')

      if (typeof qrSrc === 'string' && qrSrc.startsWith('data:')) {
        dataUri = qrSrc
      }

      if (!dataUri) {
        how = 'shot'
        /**
         * ⚠️ 留白要够：QR 标准要求四周至少 4 个模块的静区。
         * 早先只给 12 CSS px，175px 的码折算下来不到 1.5 个模块，
         * 手机上经常「认得出但判成失效」—— 别省这圈白。
         */
        const pad = 40
        const buf = await page.screenshot({
          clip: {
            x: Math.max(0, box.x - pad),
            y: Math.max(0, box.y - pad),
            width: box.width + pad * 2,
            height: box.height + pad * 2
          }
        }).catch(() => null)
        if (!buf) throw Object.assign(new Error('二维码截图失败'), { code: 'NO_QR' })
        dataUri = `data:image/png;base64,${Buffer.from(buf).toString('base64')}`
      }

      onLog(`取码(${why})：${how} 方式，src=${String(qrSrc).replace(/ptqrtoken=\w+/, 'ptqrtoken=***').slice(0, 90)}`)
      return dataUri
    }

    /**
     * 等这张码「变活」再取。
     *
     * 实测：页面刚打开时第一次 ptqrlogin 会回 **68「本次登录已被拒绝」**，
     * 紧接着页面自己换一张新码，之后稳定回 66「二维码未失效」。
     * 要是在 68 那一刻就把码截下来发出去，用户扫的就是那张**已经被拒的旧码** ——
     * 手机 100% 提示「登录失败，二维码已过期」。这就是前面几次失败的真正原因。
     */
    const waitAlive = async (ms = 15000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (lastPoll.code === '66' || lastPoll.code === '67') return true
        await sleep(400)
      }
      onLog(`等码变活超时（最后轮询码 ${currentPoll()}），仍然继续`)
      return false
    }
    await waitAlive()
    await sleep(1200) // 让换码那波响应先落地
    let qr = await captureQR()

    /**
     * 刷一张新码 —— QQ 的码只有 ~120 秒，聊天里发出去等人扫经常超时。
     *
     * 不重开浏览器：页面自己在过期时把码盖成「已失效，点击刷新」，
     * 点一下（或整页 reload）就能拿到新 qrsig，页面 JS 会继续轮询新的那个。
     *
     * ⚠️ 但页面**不一定**会把文案改成「已失效」——实测有的版式就静静躺着，
     * 只有码本身过期。所以留了 `force`：不看文案，直接整页重载换码。
     * 按时间主动续（比如每 100 秒调一次 force）比等文案可靠得多。
     */
    const refreshQR = async ({ force = false } = {}) => {
      const before = await pageText()
      const stale = /失效|过期|重新获取|点击刷新/.test(before)
      onLog(`刷新前页面：${before.slice(0, 90) || '(空)'}${stale ? ' → 判失效' : ' → 判未失效'}${force ? '（强制换码）' : ''}`)
      if (force || stale) {
        if (stale && !force) {
          // 先试点页面自己的刷新热区，成本最低
          await page.evaluate(() => {
            const el = document.querySelector('#qrlogin_refresh, .qrlogin_refresh, .qrcode, #qrimg')
            el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          }).catch(() => {})
          await sleep(1200)
        }
        if (force || /失效|过期|重新获取|点击刷新/.test(await pageText())) {
          onLog('整页重载换码')
          await page.reload({ waitUntil: 'domcontentloaded', timeout: QR_TIMEOUT }).catch(() => {})
          touchBrowser()
          await sleep(1200)
        }
      }
      qr = await captureQR({ why: force ? 'force' : 'refresh' })
      return qr
    }

    /**
     * 等回调。三条线同时盯：
     *   · request / framenavigated 事件（settle 会把 token 塞进 token 变量）
     *   · location.href 轮询
     *   · 黑洞主机的旁路重试
     */
    const waitForCallback = async ({ timeoutMs = SCAN_TIMEOUT, onStatus } = {}) => {
      const began = Date.now()
      let scannedNotified = false
      let rerouteTried = false

      while (Date.now() - began < timeoutMs) {
        if (token) return token
        if (closed) throw Object.assign(new Error('登录会话已结束'), { code: 'CANCELLED' })

        // 1) 「已扫码」提示（页面会换文案）
        if (!scannedNotified) {
          const scanned = await page.evaluate(
            () => /扫码成功|请在手机上确认|已扫码|确认登录|已扫描/.test(document.body?.innerText || '')
          ).catch(() => false)
          if (scanned) { scannedNotified = true; onStatus?.({ statusCode: 404 }) }
        }

        // 2) location.href 兜底
        const href = await page.evaluate(() => location.href).catch(() => '')
        const fromHref = parseAuthCallback(href)
        if (fromHref) return (settle(fromHref, 'location.href'), fromHref)

        // 3) 黑洞主机旁路：把同一条 check_sig 改投活集群再试
        if (pendingCheckSig && !rerouteTried) {
          rerouteTried = true
          onLog('check_sig 落在黑洞主机上，改投 ptlogin4.qq.com 集群重试')
          const trace = []
          const got = await resolveCheckSig(pendingCheckSig, AUTHORIZE, { absorb () {}, header: () => '' }, trace).catch(() => null)
          onLog(`旁路结果：${trace.join('；') || '无记录'}`)
          if (got?.access_token) return (settle(got, 'check_sig 旁路'), got)
        }

        await sleep(1200)
      }

      throw Object.assign(
        new Error(scannedNotified
          ? '登录超时：已经扫上了，但手机上一直没点「确认登录」'
          : '二维码过期了，重新发一次 #瓦扫码登录'),
        { code: 'QR_TIMEOUT' }
      )
    }

    /**
     * 除了 qr，还把几样诊断用的东西一起交出去：
     *   · qrSrc / page / pageText —— 出问题时能直接看页面在说什么
     *   · refreshQR             —— 码过期了不重开浏览器就能换一张
     */
    return {
      qr,
      get qrSrc () { return qrSrc },
      page,
      pageText,
      refreshQR,
      appName: '掌上无畏契约',
      waitForCallback,
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}

export default { createQQPageSession, buildAuthorizeUrl, fetchOpenid, parseAuthCallback }
