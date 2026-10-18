/**
 * 插件入口：确保数据目录 → 递归加载 `apps/` 下所有模块 → 导出 apps。
 *
 * ## 加载约定
 *
 * `apps/` 下的 `.js` **不需要注册**，扫到就加载，取第一个有效导出当云崽的 plugin 实例。
 * 新增指令只要往 `apps/` 丢一个文件，不用改这里。
 *
 * ⚠️ 单个模块加载失败**不能拖垮整个插件**：任何一个模块的语法错 / 依赖缺失，
 *    都只记一条日志并跳过，其余功能照常可用。这就是为什么每个 import 都包在 try 里。
 *    （这个约定来自 GloryOfKings-Plugin 的 index.js，60 多个模块的体量下非常必要。）
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Config, PluginName, PluginData } from '#components'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appsDir = path.join(__dirname, 'apps')

const startTime = Date.now()
const apps = {}
let successCount = 0
let failureCount = 0

logger.info(`无畏契约插件载入中...`)

/** 启动时必须存在的数据目录 */
const dirs = [
  PluginData,
  path.join(PluginData, 'assets'),
  path.join(PluginData, 'static')
]

async function ensureDirs () {
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
  }
}

/** 递归收集目录下所有 `.js` */
async function scanDirectory (directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const tasks = []

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'disabled') continue // 不想跑的模块丢进 disabled/ 即可
      tasks.push(scanDirectory(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      tasks.push({ name: path.basename(entry.name, '.js'), url: pathToFileURL(fullPath).href })
    }
  }

  return (await Promise.all(tasks)).flat()
}

async function loadModules () {
  let filePaths = []
  try {
    filePaths = await scanDirectory(appsDir)
  } catch (error) {
    logger.error(`[${PluginName}] 扫描 apps/ 失败：${error.message}`)
    return
  }

  logger.debug(`[${PluginName}] 发现 ${filePaths.length} 个模块，开始并发加载`)

  await Promise.all(filePaths.map(async ({ name, url }) => {
    try {
      const mod = await import(url)
      const instance = mod?.default || mod?.[Object.keys(mod)[0]]

      if (!instance) {
        logger.debug(`[${PluginName}] 模块 ${name} 没有可注册的导出，跳过`)
        return
      }

      // 同名文件（不同子目录）依次挂后缀，保证每个实例都被注册，后者不顶前者
      let newName = name
      let counter = 1
      while (apps[newName]) newName = `${name}_${counter++}`

      apps[newName] = instance
      successCount++
    } catch (error) {
      logger.error(`[${PluginName}] 加载模块失败：${name}`)
      logger.error(error)
      failureCount++
    }
  }))
}

await ensureDirs()

// 预热一次配置：早点把 config/config/config.yaml 生成出来，
// 也让 yaml 依赖缺失的报错在启动阶段就暴露（不至于查战绩时才炸）
Config.get('config')

await loadModules()

logger.info('----------------------')
logger.info(`无畏契约插件载入完成`)
logger.info(`成功加载：${successCount} 个`)
logger.info(`加载失败：${failureCount} 个`)
logger.info(`总耗时：${Date.now() - startTime} 毫秒`)
logger.info('----------------------')

export { apps }
