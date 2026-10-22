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
 * ## 换成别人的渲染器
 *
 * 想接别的框架 / 别的截图服务，调 `setRenderer()` 注入自己的实现（art-template + puppeteer 直出即可）。
 * 没注入也不会报错，只是出不了图。
 *
 * 之所以用**动态 import** 取云崽的 puppeteer：那是个相对云崽根目录的路径
 * （`../../../lib/puppeteer/puppeteer.js`），静态 import 会让整个 `#utils` 加载失败，
 * 连带所有指令一起挂掉。
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

/** 外部注入的渲染器 */
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
 * 把 Buffer / base64 字符串包成**图片消息段**。
 *
 * ## 为什么不能直接 `e.reply(buffer)`
 *
 * 云崽的 QQBot（**官方机器人**）适配器在
 * `plugins/QQBot-Plugin/adapter/build.js` 里逐个元素这么处理：
 *
 * ```js
 * if (typeof i === "object") i = { ...i }
 * else i = { type: "text", text: Bot.String(i) }
 * ```
 *
 * Buffer 是对象 → 被展开成 `{0:255, 1:216, 2:255, 3:224, …}` → 认不出
 * `type:"image"` → 落到 `default` 分支变成一段 markdown 文本，内容是字节数组的 JSON。
 * QQ 客户端渲染不出来，气泡里显示的就是「**消息加载失败**」。
 *
 * ## 为什么 `file` 必须是**字符串**，不能用 `segment.image(buffer)`
 *
 * 同一个文件里取图片数据是这么写的：
 *
 * ```js
 * const file = _file.url || _file.file
 * const buffer = await Bot.Buffer(file)
 * ```
 *
 * 而 `Bot.Buffer()`（`lib/util.js`）**只对字符串做解析**：
 *
 * ```js
 * if (!Buffer.isBuffer(data)) {
 *   data = this.String(data)                       // ← 对象到这里就变成 "[object Object]"
 *   if (data.startsWith("base64://")) …            // 解 base64
 *   else if (data.match(/^https?:\/\//)) …         // 下载
 *   else { … await fs.readFile(file) }             // 读本地文件
 * }
 * ```
 *
 * 所以 `segment.image(buffer)` 那种「file 是对象」的段，到这里会被 `String()` 成
 * `[object Object]`，紧接着 `image-size` 抛 `unsupported file type: undefined`，
 * 日志里就是：
 *
 * ```text
 * 图片分辨率检测错误 <Buffer 5b 6f 62 6a 65 63 74 20 4f 62 6a 65 63 74 5d>   ← "[object Object]"
 * ```
 *
 * 结论：**Buffer 一定要自己拼成 `base64://…` 字符串**，别交给 `segment.image()`。
 *
 * ## 还有一层：云崽的 `screenshot()` 返回的**本身就是图片段**
 *
 * ```js
 * // lib/puppeteer/puppeteer.js
 * renderer.screenshot = async (name, data) => {
 *   const img = await renderer.render(name, data)   // Buffer
 *   return img ? segment.image(img) : img           // → { type:'image', file: Buffer }
 * }
 * ```
 *
 * 于是插件里 `await puppeteer.screenshot(...)` 拿到的是**段对象**，不是 Buffer。
 * 把段对象整个丢进来，`String()` 一次还是 `"[object Object]"` —— 症状从
 * 「分辨率检测错误」变成 `ENOENT: open '[object Object]'`（`uploadMedia` 把 file 当路径读）。
 *
 * 所以这里统一**递归解包**：段 → `.file` → Buffer → `base64://…`。
 *
 * @param {Buffer|string|object|null} img Buffer / base64 / 图片段 / 嵌套段
 * @returns {object|null} `{type:'image', file}`；给空返回 null
 */
export function imageSegment (img) {
  const file = fileString(img)
  if (!file) return null

  // 字符串（file:// / http:// / base64://）交给框架的 segment 最稳
  const seg = globalThis.segment
  if (typeof seg?.image === 'function') {
    try { return seg.image(file) } catch {}
  }
  return { type: 'image', file }
}

/**
 * 从任意「图片值」里掏出可用的 `file` 字符串。
 *
 * 云崽这条链是**两层包裹**的，不拆就会拿到 `[object Object]`：
 *
 * ```js
 * // lib/puppeteer/puppeteer.js
 * renderer.screenshot = async (name, data) => {
 *   const img = await renderer.render(name, data)     // Buffer
 *   return img ? segment.image(img) : img             // → { type:'image', file: Buffer }
 * }
 * ```
 *
 * 所以插件里 `puppeteer.screenshot()` 拿到的**不是 Buffer，而是一个图片段**。
 * 只判 `Buffer.isBuffer` 会漏掉它，`String(segment)` 就成了 `"[object Object]"`。
 *
 * 这里递归往下拆（深度限 4 层防环），最终只产出字符串：
 * Buffer / TypedArray → `base64://…`；字符串原样返回。
 */
function fileString (input, depth = 0) {
  if (input == null || depth > 4) return ''

  const buf = toBuffer(input)
  if (buf) return buf.length ? `base64://${buf.toString('base64')}` : ''

  if (typeof input === 'string') return input

  if (typeof input === 'object') {
    const next = input.file ?? input.data ?? input.buffer
    if (next != null && next !== input) return fileString(next, depth + 1)
  }

  return ''
}

/**
 * 把各种「二进制」归一到 Buffer。
 *
 * ⚠️ **puppeteer 25 的 `page.screenshot()` 返回的是 `Uint8Array`，不是 Buffer**
 * （实测 `Buffer.isBuffer(buf) === false`，`buf.constructor.name === 'Uint8Array'`）。
 * 只判 `Buffer.isBuffer` 会漏掉它 → 走到 `String(uint8array)` → 变成
 * `"255,216,255,224,…"` 这种字符串，照样不是图片。
 */
function toBuffer (img) {
  if (Buffer.isBuffer(img)) return img
  if (img instanceof ArrayBuffer) return Buffer.from(img)
  if (ArrayBuffer.isView(img)) return Buffer.from(img.buffer, img.byteOffset, img.byteLength)
  return null
}

/**
 * 出图并回复，失败退化为一段文字提示
 * @param {object} e 事件对象（云崽的 e，带 reply）
 */
export async function replyImage (e, name, tpl, data = {}, opts = {}) {
  const img = await render(name, tpl, data, opts)
  if (!img) {
    await e.reply('出图失败了，稍后再试；一直这样的话让主人看下日志（多半是 Chromium 没装好）。')
    return false
  }
  // ⚠️ 必须包成图片段 —— 裸 Buffer 在 QQ 官方机器人上会变成「消息加载失败」
  await e.reply(imageSegment(img) ?? img)
  return true
}
