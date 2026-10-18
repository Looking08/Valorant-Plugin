/**
 * 扫码登录适配器注册表。
 *
 * 加一个平台 = 新建 `xxx.js`，导出 `{ name, start(), poll(state) }`，
 * 在这里 register 一行。插件侧不用改（它只认 start/poll 的状态机）。
 */
import LoginManager from './session.js'
import qqAdapter from './qq.js'
import wechatAdapter from './wechat.js'
import wxwebAdapter from './wxweb.js'
import mockAdapter from './mock.js'

export function createLoginManager () {
  const manager = new LoginManager()
  manager.register('qq', qqAdapter)

  // 两个微信：
  //   wx    开放平台「网站应用」，要审核资质，但能换 openid（正规做法）
  //   wxweb 网页版微信
  manager.register('wx', wechatAdapter)

  // ⚠️ wxweb 默认**不挂载**，因为它登录的是「微信网页版」——
  //    拿到的是微信会话，跟无畏契约的战绩数据毫无关系（实测能确认成功，
  //    但那个 skey/pass_ticket 调用不了任何 val.qq.com 接口）。
  //    留着它的唯一价值：验证「出码 → 已扫 → 已确认」这条链路本身是通的。
  //    想跑就显式加 LOGIN_EXPERIMENTAL=1，免得有人以为「扫码就能查战绩」。
  if (process.env.LOGIN_EXPERIMENTAL === '1') {
    manager.register('wxweb', wxwebAdapter)
    console.warn('[gateway] ⚠️ LOGIN_EXPERIMENTAL=1：已挂载 wxweb（登录微信网页版，与战绩无关，仅验证链路）')
  }

  // 只在显式开启时挂上来 —— 这是给「调 UI / 跑测试」用的假登录，
  // 默认不注册，免得有人以为扫码真通了。
  if (process.env.LOGIN_MOCK === '1') {
    manager.register('mock', mockAdapter)
    console.warn('[gateway] ⚠️ LOGIN_MOCK=1：已挂载模拟登录适配器（仅用于调试 UI）')
  }

  return manager
}

export { LoginManager, qqAdapter, wechatAdapter, wxwebAdapter }
export default createLoginManager
