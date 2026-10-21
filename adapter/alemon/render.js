/**
 * alemonjs 侧的出图。
 *
 * 云崽那边是「框架自带的 puppeteer + art-template」，`screenshot(模板名, {tplFile, ...数据})`
 * 一条龙。alemonjs 核心不带渲染器（生态里的 `jsxp` 走的是 React 组件，跟我们这 6 个
 * art-template 模板不是一套），所以这里自己拼：
 *
 *   art-template 渲染 HTML → 落到临时文件 → puppeteer 截图 → Buffer
 *
 * 两个依赖都是**运行时动态 import**，没装就优雅降级（返回 false，`replyImage` 会
 * 改发一段文字），不会因为缺包导致整个插件加载失败。
 *
 * 装法（在 alemonjs 项目根目录执行）：
 *   npm i art-template puppeteer
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginRes, PluginData } from '#components'

/** 动态 import 一个可选依赖，装了返回模块，没装返回 null */
async function optionalImport (name) {
  try {
    const mod = await import(name)
    return mod?.default ?? mod
  } catch {
    return null
  }
}

/** 缓存探测结果，别每条指令都试一次 import */
const cache = { art: undefined, puppeteer: undefined, warned: false }

async function resolveDeps () {
  if (cache.art === undefined) cache.art = await optionalImport('art-template')
  if (cache.puppeteer === undefined) cache.puppeteer = await optionalImport('puppeteer')
  return { art: cache.art, puppeteer: cache.puppeteer }
}

function warnOnce (message) {
  if (cache.warned) return
  cache.warned = true
  logger.warn(`[瓦插件] ${message}`)
}

/**
 * 渲染一张图。
 *
 * @param {object} ctx { name, tpl, data, opts }（由 utils/render.js 传入）
 * @returns {Promise<Buffer|false>}
 */
export async function renderOnAlemon (ctx) {
  const { name, tpl, data = {}, opts = {} } = ctx
  const { art, puppeteer } = await resolveDeps()

  if (!art || !puppeteer) {
    warnOnce('出图需要 art-template 和 puppeteer，在 alemonjs 项目根目录执行：npm i art-template puppeteer')
    return false
  }

  const tplPath = path.join(PluginRes, 'html', String(tpl || ''))
  if (!tplPath.startsWith(PluginRes) || !fs.existsSync(tplPath)) {
    logger.error(`[瓦插件] 模板不存在：${tplPath}`)
    return false
  }

  // 模板里的 `{{@res}}` 是资源前缀。云崽用 `../../../` 那种相对路径（渲染产物落在
  // temp/html/ 下），这里没有那层目录，直接给 file:// 绝对路径最省事。
  const resPrefix = `file://${PluginRes}/`
  const merged = { ...data, res: resPrefix }

  let html
  try {
    html = art.render(fs.readFileSync(tplPath, 'utf8'), merged)
  } catch (error) {
    logger.error(`[瓦插件] 模板渲染失败（${tpl}）：${error.message}`)
    return false
  }

  // 落到临时文件再用 file:// 打开：相对资源（css / 字体 / 图片）才能正确加载，
  // setContent 的 baseURL 是 about:blank，file:// 子资源会被拦。
  const tmpDir = path.join(PluginData, 'render')
  fs.mkdirSync(tmpDir, { recursive: true })
  const tmpFile = path.join(tmpDir, `${String(name).replace(/[^\w.-]/g, '_')}.html`)
  fs.writeFileSync(tmpFile, html, 'utf8')

  let browser
  try {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--allow-file-access-from-files', // 允许 file:// 页面加载本地字体
        '--font-render-hinting=none'
      ]
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 900, deviceScaleFactor: 2 })
    await page.goto(`file://${tmpFile}`, { waitUntil: 'networkidle2', timeout: 30000 })

    const buf = await page.screenshot({
      type: opts.imgType === 'png' ? 'png' : 'jpeg',
      quality: opts.quality || 90,
      fullPage: true
    })
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  } catch (error) {
    logger.error(`[瓦插件] 截图失败（${name}）：${error.message}`)
    return false
  } finally {
    if (browser) await browser.close().catch(() => {})
    fs.rmSync(tmpFile, { force: true })
  }
}

/** 装一下：把渲染器接进 utils/render.js */
export async function installRenderer () {
  const { setRenderer } = await import('../../utils/render.js')
  setRenderer(renderOnAlemon)
}

/** 临时目录（给「清缓存」指令用） */
export const RENDER_TMP_DIR = path.join(PluginData, 'render')
