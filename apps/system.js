/**
 * 小工具指令：`#瓦状态` / `#瓦清缓存`
 *
 * 排查问题时这几条最有用：数据源不通 vs 插件坏了，一眼就能分开。
 */
import {
  health,
  clearStaticCache,
  clearAssetCache,
  getLastProvider,
  gateway,
  staticApi,
  getCollection
} from '#utils'

export class ValorantSystem extends plugin {
  constructor () {
    super({
      name: '瓦插件_系统',
      dsc: '无畏契约插件状态与缓存维护',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?瓦(状态|数据源状态)$', fnc: 'status' },
        { reg: '^#?瓦(强制)?清缓存$', fnc: 'clear', permission: 'master' }
      ]
    })
  }

  async status (e) {
    const lines = ['【无畏契约插件状态】', '']

    // 1) 战绩网关
    const gw = gateway()
    if (!gw.url) {
      lines.push('· 战绩网关：❌ 未配置（只能出图查不了数据）')
    } else {
      try {
        const start = Date.now()
        const res = await health()
        lines.push(`· 战绩网关：✅ ${gw.url}（${Date.now() - start}ms）`)
        if (res?.data?.provider) lines.push(`  数据源 provider：${res.data.provider}`)
      } catch (error) {
        lines.push('· 战绩网关：❌ ' + String(error.message).split('\n')[0])
      }
    }

    // 2) 静态数据源
    try {
      const maps = await getCollection('maps')
      lines.push(`· 静态数据：✅ ${staticApi().url}（地图 ${maps.length} 张）`)
    } catch (error) {
      lines.push(`· 静态数据：❌ ${error.message}`)
    }

    if (getLastProvider()) lines.push(`· 上次查询走的数据源：${getLastProvider()}`)

    lines.push('', '· 发 #瓦帮助 看所有指令')
    await e.reply(lines.join('\n'))
    return true
  }

  async clear (e) {
    const okAsset = clearAssetCache()
    const okStatic = await clearStaticCache()
    await e.reply(`缓存已清理：图片 ${okAsset ? '✅' : '❌'} / 静态数据 ${okStatic ? '✅' : '❌'}`)
    return true
  }
}

export default ValorantSystem
