/**
 * 出图封装。
 *
 * ## 云崽（含 TRSS）
 *
 * 渲染器是框架自带的 **art-template + puppeteer**，调用形式是：
 * ```js
 * puppeteer.screenshot('模板名', { tplFile: 'plugins/xxx/resources/html/a.html', ...数据 })
 * ```
 * 模板渲染后的 HTML 落在 `temp/html/<模板名>/`，所以模板里引用本地资源要用
 * `../../../` 开头的相对路径（见 utils/asset.js 的 templatePath）。
 *
 * ⚠️ `screenshot` 渲染失败时**返回 false 而不抛异常**（renderers/puppeteer 的行为），
 *    所以这里必须显式判空 —— 不判的话用户会收到一个 null 幽灵消息。
 *
 * ## 其它框架（alemonjs）
 *
 * 没有框架自带的渲染器，由 `adapter/alemon/render.js` 调 `setRenderer()` 注入自己的实现
 * （art-template + puppeteer 直出）。没注入也不会报错，只是出不了图。
 *
 * 之所以用**动态 import** 取云崽的 puppeteer：那是个相对云崽根目录的路径
 * （`../../../lib/puppeteer/puppeteer.js`），在别的框架里根本不存在，
 * 静态 import 会让整个 `#utils` 加载失败，连带所有指令一起挂掉。
 */
import path from 'node:path'
import { PluginRes } from '#components'
import { getLastProvider } from './gateway.js'
import { dateTime } from './format.js'

/** 模板里引用 resources/ 用的前缀 */
export const RES = templatePathLike(PluginRes)

function templatePathLike (absDir) {
  return `../../../${path.relative(process.cwd(), absDir).split(path.sep).join('/')}/`
}

/** 外部注入的渲染器（alemonjs 等） */
let injected = null

/**
 * 换掉出图实现。传 null 恢复云崽默认。
 * @param {((ctx: {name,tpl,data,res,opts}) => Promise<Buffer|false>)|null} fn
 */
export function setRenderer (fn) {
  injected = typeof fn === 'function' ? fn : null
}

/** 当前生效的渲染器 */
export function getRendererName () {
  return injected ? 'injected' : 'yunzai-puppeteer'
}

/** 云崽默认：把活交给框架自带的渲染器 */
async function yunzaiRender (ctx) {
  const puppeteer = (await import('../../../lib/puppeteer/puppeteer.js')).default
  if (!puppeteer?.screenshot) throw new Error('云崽渲染器不可用（lib/puppeteer/puppeteer.js）')

  return puppeteer.screenshot(ctx.name, {
    tplFile: `plugins/Valorant-Plugin/resources/html/${ctx.tpl}`,
    quality: ctx.opts.quality || 90,
    imgType: ctx.opts.imgType || 'jpeg',
    multiPage: !!ctx.opts.multiPage,
    multiPageHeight: ctx.opts.multiPageHeight || 4000,
    res: ctx.res,
    provider: getLastProvider() || '',
    updatedAt: dateTime(Date.now()),
    ...ctx.data
  })
}

/**
 * 渲染一张图
 * @param {string} name 模板名（决定缓存文件名）
 * @param {string} tpl  `resources/html` 下的文件名
 * @param {object} data 模板数据
 * @param {object} opts { quality, imgType, multiPage }
 * @returns {Promise<Buffer|false>} 图片；失败返回 false
 */
export async function render (name, tpl, data = {}, opts = {}) {
  let img = false
  try {
    img = await (injected || yunzaiRender)({ name, tpl, data, res: RES, opts })
  } catch (error) {
    logger.error(`[瓦插件] 渲染 ${name} 抛异常：${error.message}`)
  }

  // ⚠️ false / undefined 都要拦住：渲染器失败时不抛，返回的是 false
  if (!img) {
    logger.error(`[瓦插件] 渲染 ${name} 失败（${injected ? '注入的渲染器' : 'puppeteer'} 返回空）`)
    return false
  }
  return img
}

/**
 * 出图并回复，失败退化为一段文字提示
 * @param {object} e 事件对象（云崽的 e / alemonjs 适配后的 e，都有 reply）
 */
export async function replyImage (e, name, tpl, data = {}, opts = {}) {
  const img = await render(name, tpl, data, opts)
  if (!img) {
    await e.reply('出图失败了，稍后再试；一直这样的话让主人看下日志（多半是 Chromium 没装好）。')
    return false
  }
  await e.reply(img)
  return true
}
