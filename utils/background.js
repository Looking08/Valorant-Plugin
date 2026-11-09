/**
 * 出图背景（皮肤）。
 *
 * 设计目标只有一个：**用户往目录里丢张图就能换背景**，不用改代码、不用重启。
 *
 * ```
 * resources/bg/
 *     reyna.jpg
 *     jett.png
 *     说明.txt
 * ```
 *
 * 配置（`config/config.yaml` → `render`）：
 * ```yaml
 * render:
 *   background: all        # all = 每次随机 / false = 关闭 / 'reyna.jpg' = 固定某张
 *   veil: 0.72             # 盖在背景图上的白纱浓度，越大字越清楚、图越淡
 *   blur: 12               # 卡片毛玻璃模糊度（px），0 = 关闭
 * ```
 *
 * 为什么是「平铺一个目录」而不是 miao-plugin 那种 `theme/<名字>/{main.png,bg.jpg,config.js}`：
 * 本插件的背景就是一张铺满的画，没有「主图 + 背景图」两层结构，也不需要每套皮肤
 * 单独写 config —— 多一层的收益只是能逐套调色，代价是用户加张图得先建文件夹、
 * 还得记住主图必须叫 main.png。这里只需要文件名。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginRes } from '#components'
import { view } from './config.js'

/**
 * 背景图 URL 前缀。
 *
 * ⚠️ 必须是 `../bg/` 这种**相对 base.css** 的写法，不能用 resources 那套
 *    `../../../plugins/...`：`--bg-img` 这个自定义属性是在 base.css 里被
 *    `background-image` 消费的，Chrome 解析 url() 时以 **base.css 所在目录**
 *    为基准，不是以 HTML 为基准。写成插件根相对路径会变成
 *    `resources/css/../../../plugins/...` 而 404 —— 这种现象很坑，
 *    图不报错、只是默默不显示，看上去像"背景功能没生效"。
 *    `../bg/x.jpg` 从 resources/css 往上跳一级正好是 resources/bg，
 *    插件装在哪都不会错。
 */
const BG_URL = '../bg/'

/** 认得的图片后缀 */
const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'])

/** 背景目录（resources/bg） */
export function bgDir () {
  return path.join(PluginRes, 'bg')
}

/**
 * 列出所有可用背景（文件名，按字典序，便于用户对号入座）
 * 目录不存在时返回空数组 —— 不是错误，只是没配背景。
 */
export function listBackgrounds () {
  try {
    return fs
      .readdirSync(bgDir())
      .filter(file => EXT.has(path.extname(file).toLowerCase()))
      .sort()
  } catch {
    return []
  }
}

/**
 * 挑一张背景。
 *
 * 每次出图都重新扫目录，所以**新丢进去的图不用重启就能用**。
 *
 * @returns {{ name: string, url: string } | null} url 是相对 base.css 的地址
 */
export function pickBackground () {
  const cfg = view()
  if (cfg.background === false) return null

  const all = listBackgrounds()
  if (!all.length) return null

  let file = ''
  if (cfg.background && cfg.background !== 'all') {
    // 指定了某张：允许省略后缀，找不到就老实不显示，
    // 而不是偷偷换成随机的 —— 否则用户会以为配置没生效。
    const want = String(cfg.background)
    file = all.find(f => f === want) ||
      all.find(f => f.toLowerCase() === want.toLowerCase()) ||
      all.find(f => path.parse(f).name.toLowerCase() === want.toLowerCase()) ||
      ''
    if (!file) return null
  } else {
    file = all[Math.floor(Math.random() * all.length)]
  }

  return { name: file, url: BG_URL + file }
}
