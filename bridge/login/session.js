/**
 * 扫码登录会话管理。
 *
 * ## 为什么放在网关而不是插件里
 *
 * 「扫码」这件事只有两段是通用的：出二维码、轮询状态。中间那步
 * 「拿着 cookie 去换业务 token」跟具体站点强耦合（掌瓦 App vs 官网 web
 * vs 微信小程序，三套都不一样）。所以：
 *
 *   插件  ── 只管交互（出图、轮询、提示）──  不看是哪家平台
 *   网关  ── 管会话 + 适配器（qq / wx / 自定义）── 对插件只暴露状态机
 *
 * 加一个新平台 = 在 login/ 下加一个 adapter，插件一行都不用改。
 *
 * ## 状态机
 *
 *   waiting   出码成功，等人扫
 *   scanned   手机扫了，等确认
 *   confirmed 确认登录，拿到凭证
 *   expired   二维码过期（重新发指令即可）
 *   blocked   上游不响应（被风控 / 参数不对），需要换方案
 *   cancelled 主动取消
 */
import crypto from 'node:crypto'

/**
 * 二维码有效期，腾讯侧一般 120s，留点余量。
 * 网页版微信的码能撑 5 分钟左右，需要更久时用 LOGIN_TTL=300 起网关。
 */
const TTL = Number(process.env.LOGIN_TTL) || 180

export class LoginManager {
  constructor () {
    this.sessions = new Map()
    this.adapters = new Map()
    this.timer = setInterval(() => this.gc(), 60 * 1000)
    this.timer.unref?.()
  }

  register (name, adapter) {
    this.adapters.set(name, adapter)
    return this
  }

  /** 已注册的适配器名 —— 插件据此提示「哪个能用、哪个没配」 */
  list () {
    return [...this.adapters.keys()]
  }

  /**
   * 开一个扫码会话
   * @param {string} type qq / wx / 其它已注册的 adapter
   */
  async start (type, user = '') {
    const adapter = this.adapters.get(String(type || 'qq').toLowerCase())
    if (!adapter) {
      const error = new Error(`不支持的扫码方式：${type}，可用：${[...this.adapters.keys()].join(' / ')}`)
      error.code = 'NOT_SUPPORTED'
      throw error
    }

    const id = crypto.randomBytes(8).toString('hex')
    const session = {
      id,
      // 谁在扫码 —— 落库时要按人分开存，不能都写进部署者那一份
      user: String(user || ''),
      type: adapter.name,
      status: 'waiting',
      message: '请用手机扫码',
      createdAt: Date.now(),
      expireAt: Date.now() + TTL * 1000,
      emptyPolls: 0,
      state: null,
      qr: '',
      profile: null,
      cookies: null,
      credential: null
    }

    // 先登记再出码：出码可能要 1~2s，期间用户问状态也要能查到
    this.sessions.set(id, session)

    try {
      const { qr, state } = await adapter.start()
      session.qr = qr
      session.state = state
      return { sessionId: id, type: adapter.name, qr, expireIn: TTL }
    } catch (error) {
      this.sessions.delete(id)
      throw error
    }
  }

  /** 查状态（顺带推进一次轮询） */
  async poll (id) {
    const session = this.sessions.get(String(id || ''))
    if (!session) {
      const error = new Error('扫码会话不存在或已过期，请重新发送指令')
      error.code = 'NOT_FOUND'
      throw error
    }
    if (['confirmed', 'expired', 'blocked', 'cancelled'].includes(session.status)) {
      return this.view(session)
    }
    if (Date.now() > session.expireAt) {
      session.status = 'expired'
      session.message = '二维码已过期，重新发一次指令吧'
      return this.view(session)
    }

    const adapter = this.adapters.get(session.type)
    let result
    try {
      result = await adapter.poll(session.state)
    } catch (error) {
      session.status = 'blocked'
      session.message = `轮询失败：${error.message}`
      return this.view(session)
    }

    // 上游连续空响应 = 被风控或不认这套参数，别让用户干等
    if (result.status === 'waiting' && result.upstreamEmpty) {
      session.emptyPolls += 1
      if (session.emptyPolls >= 5) {
        session.status = 'blocked'
        session.message = result.hint || '上游一直没有响应（大概率是被风控拦了），需要换浏览器方案或改用抓包凭证'
        return this.view(session)
      }
    }

    session.status = result.status
    if (result.message) session.message = result.message
    if (result.cookies) session.cookies = result.cookies
    if (result.profile) session.profile = result.profile
    // 适配器已经把它换成了「能直接查数据」的凭证（掌瓦这条路是 cookie + scene）
    if (result.credential) session.credential = result.credential

    return this.view(session)
  }

  /**
   * 登录成功后把凭证交给 provider 落库
   * @param {string} id
   * @param {object} provider 有 saveLogin 就用，没有就只把凭证留在会话里
   */
  async commit (id, provider) {
    const session = this.sessions.get(String(id || ''))
    if (!session || session.status !== 'confirmed') return null

    if (typeof provider.saveLogin !== 'function') {
      return {
        saved: false,
        hint: '登录成功了，但当前数据源没有实现 saveLogin()，凭证没有落地。在 provider 里实现它即可把 cookie 换成战绩接口用的 token。'
      }
    }
    const ret = await provider.saveLogin({
      // ⚠️ user 必须带上：不带就会写进 mate.json 本体，
      //    等于把扫码的人覆盖成部署者自己
      user: session.user,
      type: session.type,
      cookies: session.cookies,
      credential: session.credential,
      profile: session.profile
    })
    return { saved: true, ...(ret || {}) }
  }

  cancel (id) {
    const session = this.sessions.get(String(id || ''))
    if (session && !['confirmed', 'expired', 'blocked'].includes(session.status)) {
      session.status = 'cancelled'
      session.message = '已取消'
    }
    return session ? this.view(session) : null
  }

  /**
   * 给插件看的视图：不把内部 state（含 qrsig 等）暴露出去。
   *
   * ⚠️ 刻意**不带 qr**：二维码只在 start() 里给一次就够，轮询每 2 秒回一次
   *    55KB 的 base64 是纯粹的浪费（微信的码有 300×300）。插件也不看这个字段。
   */
  view (session) {
    return {
      sessionId: session.id,
      type: session.type,
      status: session.status,
      message: session.message,
      profile: session.profile,
      leftSeconds: Math.max(0, Math.round((session.expireAt - Date.now()) / 1000))
    }
  }

  gc () {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      // 终态留 5 分钟方便前端回查，之后清掉
      const keep = ['confirmed', 'cancelled', 'expired', 'blocked'].includes(session.status)
      if (keep && now - session.createdAt > 5 * 60 * 1000) this.sessions.delete(id)
      else if (!keep && now > session.expireAt + 60 * 1000) this.sessions.delete(id)
    }
  }
}

export default LoginManager
