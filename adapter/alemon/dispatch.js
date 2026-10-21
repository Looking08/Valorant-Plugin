/**
 * alemonjs 侧的指令分发。
 *
 * 云崽是「框架读 `rule[].reg` 正则，命中即调 `fnc`」；alemonjs 的 Router 只认
 * **精确字符串 key**（`use('瓦战绩')`），正则得走 `router.res({ regular })` 这种全局
 * 兜底 —— 所以干脆自己分发：拿一条总正则把所有 `#瓦…` 收进来，内部照云崽的规则挑。
 *
 * 好处是**指令表完全复用 `apps/` 里的 rule**，加指令不用改适配层，行为也和云崽一致：
 * - 按 `priority` 升序（云崽里数值越大越靠后，`update.js` 的 5010 就是兜底）；
 * - 命中即停；`fnc` 返回 `false` 表示「这条不处理」，继续往下试；
 * - `rule.permission === 'master'` 只放主人过。
 */
import { installShim } from '../shim.js'
import { loadAppClasses } from '../apps.js'
import { createYunzaiEvent } from './event.js'

/** 编译好的指令表（懒加载一次） */
let table = null

/** 云崽的 rule.reg 可能是字符串也可能是正则，统一成正则 */
function toRegExp (reg) {
  if (reg instanceof RegExp) return reg
  try {
    return new RegExp(String(reg ?? ''))
  } catch {
    return null
  }
}

async function buildTable () {
  if (table) return table

  installShim()

  const classes = await loadAppClasses(msg => logger.error(`[瓦插件] ${msg}`))
  const list = []

  for (const { name, Ctor } of classes) {
    let inst
    try {
      inst = new Ctor()
    } catch (error) {
      logger.error(`[瓦插件] 实例化 ${name} 失败：${error.message}`)
      continue
    }

    for (const rule of inst.rule || []) {
      const reg = toRegExp(rule.reg)
      if (!reg) {
        logger.error(`[瓦插件] ${name} 的 rule 正则无法解析：${rule.reg}`)
        continue
      }
      if (typeof inst[rule.fnc] !== 'function') {
        logger.error(`[瓦插件] ${name} 里找不到方法 ${rule.fnc}`)
        continue
      }
      list.push({ owner: name, inst, reg, fnc: rule.fnc, priority: inst.priority ?? 1000, permission: rule.permission })
    }
  }

  list.sort((a, b) => a.priority - b.priority)
  table = list
  logger.info(`[瓦插件] 已注册 ${list.length} 条指令（alemonjs 适配）`)
  return table
}

/**
 * 分发一条消息。由 `alemon.js` 注册的正则路由调用。
 * @returns {Promise<boolean>} 是否有指令命中
 */
export async function dispatch () {
  const e = await createYunzaiEvent()
  const text = String(e.msg || '')
  const list = await buildTable()

  for (const item of list) {
    // 带 /g 的正则 test 会留下 lastIndex，重置一下免得隔次匹配失败
    if (item.reg.global) item.reg.lastIndex = 0
    if (!item.reg.test(text)) continue

    if (item.permission === 'master' && !e.isMaster) {
      await e.reply('这个指令只有机器人主人能用。')
      return true
    }

    try {
      // 云崽基类会在调用前把事件挂到实例上，apps/update.js 依赖 this.e
      item.inst.e = e
      const ret = await item.inst[item.fnc](e)
      // false = 这条不处理，继续往下找；其它一律视为已处理
      if (ret === false) continue
      return true
    } catch (error) {
      logger.error(`[瓦插件] ${item.owner}.${item.fnc} 执行失败：${error.message}`)
      logger.error(error)
      await e.reply('指令执行出错了，详情看日志。').catch(() => {})
      return true
    }
  }

  return false
}

/** alemonjs 的 importer 拿到的就是这个 */
export default async function handler () {
  return dispatch()
}

/** 启动预热：第一次调用会扫 apps/ 建表。让 onReady 里调一次，
 *  启动日志就能直接看到「已注册 N 条指令（alemonjs 适配）」，
 *  不用等第一条消息才暴露扫描/垫片错误。 */
export const warmup = buildTable
