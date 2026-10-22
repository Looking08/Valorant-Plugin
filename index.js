/**
 * 云崽入口：确保数据目录 → 递归加载 `apps/` 下所有模块 → 导出 apps。
 *
 * ## 加载约定
 *
 * `apps/` 下的 `.js` **不需要注册**，扫到就加载，取「有 prototype 的导出」当云崽的
 * plugin 实例。新增指令只要往 `apps/` 丢一个文件，不用改这里。
 *
 * ⚠️ 单个模块加载失败**不能拖垮整个插件**：任何一个模块的语法错 / 依赖缺失，
 *    都只记一条日志并跳过，其余功能照常可用。
 *    （这个约定来自 GloryOfKings-Plugin 的 index.js，60 多个模块的体量下非常必要。）
 *
 * 扫描逻辑抽到了 `adapter/apps.js`，这里只负责建目录、加载、报数。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { Config, PluginName, PluginData } from '#components'
import { loadAppClasses } from './adapter/apps.js'

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

async function loadModules () {
  const classes = await loadAppClasses(message => {
    logger.error(`[${PluginName}] ${message}`)
    failureCount++
  })

  for (const { name, Ctor } of classes) {
    apps[name] = Ctor
    successCount++
  }

  logger.debug(`[${PluginName}] 注册 ${successCount} 个指令模块`)
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
