/**
 * 微信扫码登录适配器 —— 走微信「扫码 SDK」，不需要浏览器、不需要白名单。
 *
 * ## 之前为什么判断错了
 *
 * 我原先以为只有两条路：
 *   · 网站应用 `qrconnect`  —— 要 redirect_uri 在开放平台备案（腾讯的域名，拿不到 code）
 *   · App 内 SSO `SendAuth` —— 要手机装了微信，和 Bot 无关
 * 于是得出「微信扫码做不了」的结论。
 *
 * 漏掉的第三条才是正解：**扫码 SDK**（`/connect/sdk/qrconnect`）。
 * 它压根没有 redirect_uri 这个概念，code 由长轮询接口直接吐给你，
 * 手机 App 里那个「用微信扫一扫登录」用的就是这套。唯一门槛是 `sdk_ticket`——
 * 而掌瓦自己开了个免鉴权的取票接口，门槛也没了。
 *
 * ## 链路
 *
 *   1. POST app.mval.qq.com/go/auth/get_sdk_ticket        → ticket
 *   2. signature = sha1(appid=..&noncestr=..&sdk_ticket=..&timestamp=..)
 *   3. GET  open.weixin.qq.com/connect/sdk/qrconnect      → uuid + 二维码(JPEG base64)
 *   4. GET  long.open.weixin.qq.com/connect/l/qrconnect   → 408 未扫 / 404 已扫 / 405 带 code
 *   5. POST app.mval.qq.com/go/auth/login_by_wechat       → 掌瓦凭证
 *
 * ## 实测（2026-10）
 *
 *   ticket  → 128 字符
 *   出码    → errcode=0，appname 回显「掌上无畏契约」
 *   轮询    → {"wx_errcode":408, "wx_code":""}
 *
 * 详见 wxqr.js 与 docs/掌瓦登录链路逆向.md。
 */

import { requestQrCode, pollQr, WX_APPID_MVAL } from './wxqr.js'
import { exchangeWX, buildCookieWX } from './exchange.js'
import { fetchRole } from './qq.js'

/** 掌瓦自己的 appid；用错 appid 换票必 40029（微信按 appid 隔离 code） */
const APPID = process.env.WX_APPID || WX_APPID_MVAL

export const wechatAdapter = {
  name: 'wx',

  async start () {
    const { uuid, qr, appName } = await requestQrCode({ appid: APPID })

    return {
      qr,
      state: { mode: 'sdk', uuid, appid: APPID, appName },
      mode: 'sdk'
    }
  },

  async poll (state) {
    if (!state?.uuid) {
      return { status: 'blocked', message: '会话状态缺失，重新发一次 #瓦微信登录' }
    }

    const st = await pollQr({ uuid: state.uuid })

    if (st.status === 'waiting' || st.status === 'scanned') {
      return { status: st.status, message: st.message }
    }
    if (st.status === 'expired' || st.status === 'cancelled') {
      return { status: 'expired', message: st.message }
    }
    if (st.status !== 'authorized') {
      return { status: 'waiting', message: st.message || '等待扫码' }
    }

    // ---- 拿到 code，换掌瓦凭证 ----
    let info
    try {
      info = await exchangeWX({ code: st.code, appid: state.appid })
    } catch (error) {
      const isAuthFail = error.code === 'UPSTREAM_AUTH'
      return {
        status: isAuthFail ? 'blocked' : 'waiting',
        message: error.message,
        hint: isAuthFail
          ? '微信确认了但掌瓦不认这个 code。多半是 appid 不是掌瓦自己的（应为 wxcbb49f1f39656c2a），或 code 已被用过。'
          : undefined
      }
    }

    const userId = String(info.user_id || '')
    const cookie = buildCookieWX({
      openid: info.openid || '',
      accessToken: info.access_token || '',
      userId,
      tid: String(info.wt || ''),
      appid: state.appid
    })
    const role = await fetchRole(cookie).catch(() => null)

    return {
      status: 'confirmed',
      message: role?.name ? `登录成功：${role.name}` : '登录成功，但没认出角色名',
      profile: {
        nickname: role?.name || '',
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
        extra: { openid: info.openid || '', ct: info.ct || '', ctt: info.ctt || '' }
      }
    }
  }
}

export default wechatAdapter
