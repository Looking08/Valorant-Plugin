/**
 * `apps/` 扫描器 —— 云崽入口（`index.js`）和 alemonjs 入口（`alemon.js`）共用同一份。
 *
 * 两个框架要的东西不一样：
 * - 云崽要一个 `{ apps: { 名字: 类 } }`，由框架自己去 new 并注册 `rule` 正则；
 * - alemonjs 没有 `rule` 这个概念，得我们自己把类 new 出来、读 `rule`、自己分发。
 *
 * 所以这里只负责**把类找出来**，实例化的时机交给各自入口。
 *
 * ⚠️ 单个模块加载失败不能拖垮整个插件（同 index.js 的约定）：语法错 / 依赖缺失
 *    只记一条日志并跳过，其余功能照常可用。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 指令实现所在的目录 */
export const APPS_DIR = path.join(HERE, '..', 'apps')

/** 递归收集目录下所有 `.js`；`disabled/` 目录整个跳过 */
export async function scanDirectory (directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const tasks = []

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'disabled') continue
      tasks.push(scanDirectory(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      tasks.push({ name: path.basename(entry.name, '.js'), url: pathToFileURL(fullPath).href })
    }
  }

  return (await Promise.all(tasks)).flat()
}

/**
 * 扫 `apps/`，返回每个模块里「看起来像云崽指令类」的导出。
 *
 * @param {(msg: string) => void} onError 加载失败时的回调（云崽用 logger，alemonjs 也用 logger）
 * @returns {Promise<{name:string, Ctor:Function}[]>} 同名文件（不同子目录）自动加序号后缀
 */
export async function loadAppClasses (onError = () => {}) {
  let filePaths = []
  try {
    filePaths = await scanDirectory(APPS_DIR)
  } catch (error) {
    onError(`扫描 apps/ 失败：${error.message}`)
    return []
  }

  const found = []
  const used = new Set()

  await Promise.all(filePaths.map(async ({ name, url }) => {
    try {
      const mod = await import(url)

      // 模块可能导出多个东西，取「有 rule 数组」的那个 —— 那就是指令类。
      // 有的文件既有具名导出又有 default，优先具名（语义更清楚）。
      const candidates = Object.entries(mod)
        .filter(([, value]) => typeof value === 'function')
      const hit = candidates.find(([key, value]) => key !== 'default' && value?.prototype)
        || candidates.find(([, value]) => value?.prototype)
      if (!hit) {
        onError(`模块 ${name} 没有可注册的导出，跳过`)
        return
      }

      let newName = name
      let counter = 1
      while (used.has(newName)) newName = `${name}_${counter++}`
      used.add(newName)

      found.push({ name: newName, Ctor: hit[1] })
    } catch (error) {
      onError(`加载模块失败：${name}（${error.message}）`)
    }
  }))

  // 按文件名排序，保证两次启动的注册顺序一致（分发顺序稳定，便于排查）
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
