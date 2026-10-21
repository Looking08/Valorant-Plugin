/**
 * ALemonJS 入口。用法：在 alemonjs 项目的 `alemon.config.yaml` 里挂上包名
 *
 * ```yaml
 * apps:
 *   - valorant-plugin
 * ```
 *
 * 或者本地开发时直接把本仓库软链进 node_modules。
 *
 * ## 为什么只注册一条正则
 *
 * alemonjs 的 `router.group().use()` 只认**精确字符串 key**，而本插件 20 多条指令全是
 * 正则（还带别名、负向预查、`(?!详情)` 这类写法）。所以这里用
 * `router.res({ regular })` 挂一个**总入口**做粗筛，真正的匹配交给
 * `adapter/alemon/dispatch.js` —— 它读 `apps/` 里每个类的 `rule`，按 priority 分发，
 * 行为和云崽完全一致。
 *
 * 好处：加指令只改 `apps/`，适配层不用动。
 */
import { Router, defineChildren } from 'alemonjs'
import { installShim } from './adapter/shim.js'
import { installRenderer } from './adapter/alemon/render.js'

// 必须在任何 apps/ 模块被 import 之前装好：apps 里 `extends plugin`，
// 而 `plugin` 这个全局只有云崽才有。（dispatch 是懒加载的，所以这里装来得及）
installShim()

// 出图：换成 art-template + puppeteer 的实现。没装那两个包也不影响指令，只是出不了图。
await installRenderer()

/**
 * 总入口正则。要覆盖所有指令的开头：
 * - `#瓦面板` / `瓦面板`（# 可省略）
 * - `#无畏契约更新`（别名前缀不是「瓦」）
 * - `curl https://app.mval.qq.com/...`（导入登录态时直接粘 cURL，不带任何前缀）
 *
 * 粗筛宽松一点没关系 —— dispatch 内部会用每条 rule 的正则再精确匹配一次。
 */
const ENTRY = /^\s*(?:[#＃!！]?\s*(?:瓦|无畏契约).|curl\s+['"]?https:\/\/app\.mval\.qq\.com)/

const router = Router.create({
  events: ['message.create', 'private.message.create']
})

router.res(
  { events: ['message.create', 'private.message.create'], regular: ENTRY },
  () => import('./adapter/alemon/dispatch.js')
)

export default defineChildren({
  register () {
    return {
      responseRouter: router.define
    }
  },

  onReady () {
    logger.info('[瓦插件] 已挂载（ALemonJS 适配层）')
  }
})
