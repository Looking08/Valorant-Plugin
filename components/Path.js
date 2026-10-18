/**
 * 路径常量。
 *
 * ⚠️ 插件根目录必须按**本文件位置**反推（`components/` 的上级），不能用
 *    `process.cwd()` 拼：只要有脚本不在云崽根目录下 import 本模块（调试脚本、
 *    单元测试、网关服务），配置就会在那个 cwd 底下凭空造一份
 *    `plugins/Valorant-Plugin/config/`，用户数据也会写错地方。
 *    （和 GloryOfKings-Plugin 的 components/Path.js 同一个坑，直接沿用它的做法。）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 云崽根目录 */
const Path = process.cwd()

/** 插件目录名 —— 要和安装时的目录名一致，更新指令和日志前缀都用它 */
const PluginName = 'Valorant-Plugin'

/** 插件根目录 */
const PluginPath = path.resolve(fileURLToPath(import.meta.url), '../..')

/** 运行时数据根目录（配置外、进 .gitignore，重装不受影响） */
const PluginData = path.join(PluginPath, 'data')

/** 静态资源目录（HTML 模板 / 图片 / 字体） */
const PluginRes = path.join(PluginPath, 'resources')

/** 资源缓存目录（远程图片落地缓存） */
const PluginCache = path.join(PluginData, 'assets')

export {
  Path,
  PluginName,
  PluginPath,
  PluginData,
  PluginRes,
  PluginCache
}
