import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PluginCache } from '#components'
import { staticApi, display } from './config.js'

/**
 * 把磁盘绝对路径转成「渲染出来的 HTML 里能用」的相对地址。
 *
 * Yunzai 渲染器会把模板写到 `<云崽根>/temp/html/<模板名>/<模板名>.html`，
 * 再用 `file://` 打开它。也就是说模板里 `<img src="./x.png">` 的基准目录是
 * `temp/html/<模板名>/`，往上三级才是云崽根目录 —— 这个 `../../../` 前缀
 * 就是这么来的（GloryOfKings-Plugin 里的 `_res_path` 也是同一套写法）。
 *
 * @param {string} file 绝对路径
 */
export function templatePath (file) {
  if (!file) return ''
  if (/^(https?:|data:|file:)/.test(file)) return file
  return `../../../${path.relative(process.cwd(), file).split(path.sep).join('/')}`
}

/**
 * 远程图片落地缓存。
 *
 * 为什么要缓存：出图时若每张头像都走外网往返，出图耗时会完全取决于网络。
 * 落到本地之后第二次基本是秒出 —— 而且断网时旧图还能撑住。
 *
 * @param {string} url
 * @returns {Promise<string>} 本地绝对路径；缓存关闭/下载失败时原样返回 URL
 */
export async function cacheAsset (url) {
  if (!url || !/^https?:/.test(url)) return url
  if (!display().assetCache) return url

  try {
    fs.mkdirSync(PluginCache, { recursive: true })
    const ext = (path.extname(new URL(url).pathname) || '.png').toLowerCase()
    const safeExt = /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : '.png'
    const file = path.join(PluginCache, crypto.createHash('md5').update(url).digest('hex') + safeExt)

    if (fs.existsSync(file)) return file

    const res = await fetch(url, { signal: AbortSignal.timeout(staticApi().timeout) })
    if (!res.ok) return url

    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return file
  } catch {
    // 缓存失败不影响主流程，退回远程地址
    return url
  }
}

/**
 * 批量落地远程图片（并发，单张失败不影响其他）
 * @param {string[]} urls
 * @returns {Promise<string[]>} 与入参同序的结果（绝对路径或原 URL）
 */
export async function cacheAssets (urls = []) {
  return Promise.all(urls.map(u => cacheAsset(u).catch(() => u)))
}

/**
 * 「远程图片 → 模板可用地址」一步到位：先落地、再转相对路径
 * @param {string} url
 */
export async function asset (url) {
  return templatePath(await cacheAsset(url))
}

/** 一批资源转模板地址（对象数组形式：`[{url}] → [{icon}]`） */
export async function assets (list = [], key = 'url', target = 'icon') {
  const results = await cacheAssets(list.map(item => item?.[key]))
  return list.map((item, i) => ({ ...item, [target]: templatePath(results[i]) }))
}

/** 清掉本地资源缓存 */
export function clearAssetCache () {
  try {
    fs.rmSync(PluginCache, { recursive: true, force: true })
    fs.mkdirSync(PluginCache, { recursive: true })
    return true
  } catch {
    return false
  }
}
