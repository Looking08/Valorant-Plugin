/**
 * 配置读写。
 *
 * ## 约定
 *
 * · 模板：`config/default_config/*.yaml` —— 插件自带的默认值，**用户不该改这里**
 *   （升级时被 git 覆盖，改了等于白改）。
 * · 用户：`config/config/*.yaml` —— 第一次启动从模板复制；之后只补缺的键，
 *   **用户手写的注释和值全保留**。
 * · 读: `Config.get('config')` 返回「模板 ← 用户」深合并后的结果。
 * · 热更新：`fs.watch` 监听用户配置文件，改了下一次读取生效，不用重启。
 *
 * ⚠️ 全程 try/catch：一份写坏的 YAML 只该让这一份配置退化成默认值，
 *    不能让整个插件起不来（`import yaml` 失败同理 —— 说明依赖没装，给明确提示）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginPath } from './Path.js'

let YAML = null
try {
  YAML = (await import('yaml')).default
} catch {
  YAML = null
}

/** 判断是不是纯对象（深合并时用来区分「继续往下钻」和「直接覆盖」） */
function isPlainObject (v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 深合并：后面的 sources 覆盖前面的，对象递归，数组整体替换 */
function deepMerge (target, source) {
  if (!isPlainObject(source)) return source
  const out = isPlainObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = isPlainObject(value) && isPlainObject(target?.[key])
      ? deepMerge(target[key], value)
      : value
  }
  return out
}

class ConfigService {
  constructor () {
    this.defDir = path.join(PluginPath, 'config', 'default_config')
    this.userDir = path.join(PluginPath, 'config', 'config')
    /** 文件 mtime → 缓存失效用 */
    this.cache = new Map()
    this.watchers = new Map()
    this.yamlReady = !!YAML
    this.init()
  }

  /** 保证目录存在 + 用户配置缺失时从模板复制一份 */
  init () {
    if (!this.yamlReady) {
      logger.error('[瓦插件] 缺少依赖 yaml，配置功能不可用。请在云崽根目录执行：pnpm install --filter=valorant-plugin')
      return
    }
    try {
      fs.mkdirSync(this.userDir, { recursive: true })
      if (!fs.existsSync(this.defDir)) {
        fs.mkdirSync(this.defDir, { recursive: true })
        return
      }
      for (const file of fs.readdirSync(this.defDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
        const userFile = path.join(this.userDir, file)
        if (!fs.existsSync(userFile)) {
          fs.copyFileSync(path.join(this.defDir, file), userFile)
          logger.info(`[瓦插件] 已生成配置文件：${file}`)
        }
      }
    } catch (error) {
      logger.error(`[瓦插件] 配置初始化失败：${error.message}`)
    }
  }

  /**
   * 读取一份配置（模板 + 用户合并后的结果）
   * @param {string} name 不带扩展名的文件名，默认 config
   */
  get (name = 'config') {
    if (!this.yamlReady) return {}
    try {
      const defFile = path.join(this.defDir, `${name}.yaml`)
      const userFile = path.join(this.userDir, `${name}.yaml`)
      const stamp = `${this.mtime(defFile)}|${this.mtime(userFile)}`

      if (this.cache.get(name)?.stamp === stamp) return this.cache.get(name).value

      // 解析必须分开 try：用户那份写坏了，模板的默认值还得能救场
      let def = {}
      let user = {}
      try {
        if (fs.existsSync(defFile)) def = YAML.parse(fs.readFileSync(defFile, 'utf8')) || {}
      } catch (error) {
        logger.error(`[瓦插件] 默认配置 ${name}.yaml 解析失败：${error.message}`)
      }
      try {
        if (fs.existsSync(userFile)) user = YAML.parse(fs.readFileSync(userFile, 'utf8')) || {}
      } catch (error) {
        logger.error(`[瓦插件] 用户配置 ${name}.yaml 解析失败，本次按默认值运行：${error.message}`)
      }

      const value = deepMerge(def, user)
      this.cache.set(name, { stamp, value })
      this.watch(userFile, name)
      return value
    } catch (error) {
      logger.error(`[瓦插件] 读取配置 ${name} 失败：${error.message}`)
      return {}
    }
  }

  /** 直接读用户配置（不含模板补全），写配置时用得上 */
  getRaw (name = 'config') {
    return this.get(name)
  }

  mtime (file) {
    try {
      return fs.statSync(file).mtimeMs
    } catch {
      return 0
    }
  }

  /** 监听变更 → 清缓存，下次 get 重新读盘 */
  watch (file, name) {
    if (!this.yamlReady || this.watchers.has(file)) return
    try {
      const watcher = fs.watch(file, () => {
        this.cache.delete(name)
        logger.mark(`[瓦插件] 检测到 ${name}.yaml 变更，配置已热更新`)
      })
      watcher.on('error', () => {})
      this.watchers.set(file, watcher)
    } catch {}
  }
}

const Config = new ConfigService()

export default Config
export { Config }
