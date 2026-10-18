/**
 * `#components` 别名对应的聚合出口。
 *
 * 插件代码里一律写 `import { Config } from '#components'`，由 package.json 的
 * `imports` 字段映射到这里 —— 好处是 `utils/` 内部模块引用路径/配置时不必写
 * `../components/Path.js` 这种相对路径，也就避开了
 * 「utils 引 components、components 又引 utils」的循环依赖。
 */
import Config from './Config.js'
import {
  Path,
  PluginName,
  PluginPath,
  PluginData,
  PluginRes,
  PluginCache
} from './Path.js'

export {
  Path,
  Config,
  PluginName,
  PluginPath,
  PluginData,
  PluginRes,
  PluginCache
}
