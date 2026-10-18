import demoProvider from './demo.js'
import httpProvider from './http.js'
import mateappProvider from './mateapp.js'

/**
 * provider 注册表。
 *
 * provider 就是「数据从哪来」的一种实现。新增来源只要：
 *   1. 在本目录新建 `xxx.js`，导出一个带 name 和 5 个方法的对象；
 *   2. 加到下面的 map 里；
 *   3. 网关用 `PROVIDER=xxx` 启动。
 * 不用动 server.mjs，也不用动插件任何代码。
 *
 *   demo     造数据，零配置先看效果
 *   http     把请求转发给你已有的服务
 *   mateapp  掌瓦 App 抓包对接（实测跑通，见 ./mateapp.md）
 */
const providers = {
  demo: demoProvider,
  http: httpProvider,
  mateapp: mateappProvider
}

/**
 * 按名字取 provider，找不到就报错退出（比让它半死不活地跑着强）
 * @param {string} name
 */
export function resolveProvider (name) {
  const key = String(name || 'demo').toLowerCase()
  const provider = providers[key]
  if (!provider) {
    console.error(`[gateway] 未知 provider：${name}，可选：${Object.keys(providers).join(' / ')}`)
    process.exit(1)
  }
  return provider
}

export { providers, demoProvider, httpProvider, mateappProvider }
