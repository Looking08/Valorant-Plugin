/**
 * 模拟登录适配器 —— **只在 LOGIN_MOCK=1 时注册**。
 *
 * 用途：调二维码页面的 UI、跑端到端测试。它会在 6 秒后自己走到 confirmed，
 * 用来验证「轮询 → 状态变化 → 出成功提示」这条交互链路。
 *
 * ⚠️ 它不会登录任何东西。真实扫码请用 qq / wx 适配器。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const mockAdapter = {
  name: 'mock',

  async start () {
    // 借一个公开的二维码生成服务出图（仅 mock 模式，真流程各平台给的是自己的二维码）
    const data = encodeURIComponent(`valorant-plugin:mock:${Date.now()}`)
    let qr = ''
    try {
      const res = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data=${data}`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': UA }
      })
      if (res.ok) qr = `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
    } catch {}

    return {
      qr,
      state: { startedAt: Date.now(), scannedAt: 0 }
    }
  },

  async poll (state) {
    const elapsed = Date.now() - state.startedAt
    if (elapsed < 2500) return { status: 'waiting', message: '等待扫码（模拟）' }
    if (elapsed < 4500) return { status: 'scanned', message: '已扫描，请在手机上确认（模拟）' }
    return {
      status: 'confirmed',
      message: '登录成功（模拟数据，不是真登录）',
      profile: { nickname: '模拟扫码用户', uin: '10000' },
      cookies: { uin: '10000', skey: '@mock', mock: true }
    }
  }
}

export default mockAdapter
