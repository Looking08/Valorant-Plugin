/**
 * 出图封装。
 *
 * Yunzai（含 TRSS）的渲染器是 **art-template**，调用形式是：
 * ```js
 * puppeteer.screenshot('模板名', { tplFile: 'plugins/xxx/resources/html/a.html', ...数据 })
 * ```
 * 模板渲染后的 HTML 落在 `temp/html/<模板名>/`，所以模板里引用本地资源要用
 * `../../../` 开头的相对路径（见 utils/asset.js 的 templatePath）。
 *
 * ⚠️ `screenshot` 渲染失败时**返回 false 而不抛异常**（renderers/puppeteer 的行为），
 *    所以这里必须显式判空 —— 不判的话用户会收到一个 null 幽灵消息。
 */
import path from 'node:path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginRes } from '#components'
import { getLastProvider } from './gateway.js'
import { dateTime } from './format.js'

/** 模板里引用 resources/ 用的前缀 */
export const RES = templatePathLike(PluginRes)

function templatePathLike (absDir) {
  return `../../../${path.relative(process.cwd(), absDir).split(path.sep).join('/')}/`
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
  const img = await puppeteer.screenshot(name, {
    tplFile: `plugins/Valorant-Plugin/resources/html/${tpl}`,
    quality: opts.quality || 90,
    imgType: opts.imgType || 'jpeg',
    multiPage: !!opts.multiPage,
    multiPageHeight: opts.multiPageHeight || 4000,
    res: RES,
    provider: getLastProvider() || '',
    updatedAt: dateTime(Date.now()),
    ...data
  })

  // ⚠️ false / undefined 都要拦住：渲染器失败时不抛，返回的是 false
  if (!img) {
    logger.error(`[瓦插件] 渲染 ${name} 失败（puppeteer 返回空）`)
    return false
  }
  return img
}

/**
 * 出图并回复，失败退化为一段文字提示
 * @param {object} e 云崽事件对象
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
