/**
 * 框架垫片：把「云崽才有的全局」补齐，让 `apps/` 下的代码一行都不用改就能在非云崽框架里跑。
 *
 * 需要补的东西只有三个：
 * 1. `plugin` 基类 —— 所有 app 都 `extends plugin`；
 * 2. `logger` —— 日志（alemonjs 自己也挂了全局 logger，但方法集不一样，做个兼容壳）；
 * 3. `this.e` / `this.reply` —— 云崽基类会在消息到来时把事件挂到实例上，
 *    `apps/update.js` 用到了 `this.e` 和 `this.reply`。
 *
 * ⚠️ 只在**全局确实没有**时才补：云崽环境下这里必须是空操作，
 *    不然会把框架的原生实现顶掉（比如云崽的 logger 是带颜色和分级的）。
 */

/** 云崽 plugin 基类的最小实现：够 apps/ 里的用法就行 */
class YunzaiPluginShim {
  constructor (options = {}) {
    this.name = options.name || ''
    this.dsc = options.dsc || ''
    this.event = options.event || 'message'
    // 云崽里数值越大越靠后（update.js 的注释写了：更新是兜底指令，priority 给 5010）
    this.priority = Number(options.priority ?? 1000)
    this.rule = options.rule || []
    /** 当前消息事件，由分发器在调用前挂上 */
    this.e = null
  }

  /** 云崽基类的便捷回复 */
  reply (msg) {
    return this.e?.reply?.(msg)
  }
}

const LOGGER_METHODS = ['info', 'warn', 'error', 'debug', 'trace', 'fatal', 'mark', 'log']

/** 把任意 logger 包一层，缺的方法用 noop 补齐，别让 `logger.mark()` 炸掉整个指令 */
function wrapLogger (base) {
  const out = {}
  for (const method of LOGGER_METHODS) {
    const fn = base?.[method]
    out[method] = typeof fn === 'function' ? fn.bind(base) : () => {}
  }
  return out
}

/** 什么都没有时的兜底：直接打到控制台，带级别前缀 */
function consoleLogger () {
  const out = {}
  for (const method of LOGGER_METHODS) {
    out[method] = (...args) => {
      const prefix = method === 'error' ? '[瓦插件][ERROR]' : `[瓦插件][${method.toUpperCase()}]`
      // eslint-disable-next-line no-console
      console[method === 'fatal' ? 'error' : method in console ? method : 'log'](prefix, ...args)
    }
  }
  return out
}

let installed = false

/** 安装垫片。幂等，重复调用无副作用。 */
export function installShim () {
  if (installed) return
  installed = true

  if (typeof globalThis.plugin === 'undefined') {
    globalThis.plugin = YunzaiPluginShim
  }

  if (typeof globalThis.logger === 'undefined') {
    globalThis.logger = consoleLogger()
  } else {
    globalThis.logger = wrapLogger(globalThis.logger)
  }
}

export { YunzaiPluginShim }
