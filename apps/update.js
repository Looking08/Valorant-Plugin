/**
 * 插件更新（`#瓦更新` / `#瓦更新日志`）。
 *
 * 只是把云崽自带更新模块包一层 —— 那个模块会按插件目录 git pull。
 *
 * ⚠️ 这里用**动态 import**：`../../other/update.js` 是**框架**提供的模块，
 *    不是插件自己的文件（路径等价于 `<云崽根>/plugins/other/update.js`）。
 *    静态 import 的话，某个衍生框架没带这个文件就会让本模块整体加载失败；
 *    改成动态 + try，缺了就安静提示一句，不影响其它功能。
 */
import { PluginName } from '#components'

export class ValorantUpdate extends plugin {
  constructor () {
    super({
      name: '瓦插件_更新',
      dsc: '调用云崽自带更新模块更新本插件',
      event: 'message',
      // 数值越大越靠后：更新是兜底指令，具体功能的正则该先有机会匹配
      priority: 5010,
      rule: [
        { reg: '^#?(瓦|无畏契约)(插件)?(强制)?更新$', fnc: 'update', permission: 'master' },
        { reg: '^#?(瓦|无畏契约)(插件)?更新(日志|记录)$', fnc: 'update_log' }
      ]
    })
  }

  async update (e) {
    if (e.at && !e.atme) return false

    let Update
    try {
      Update = (await import('../../other/update.js')).update
    } catch {
      await e.reply('当前框架没有自带更新模块，请手动到插件目录 git pull。')
      return true
    }

    e.msg = `#${e.msg.includes('强制') ? '强制' : ''}更新${PluginName}`
    const up = new Update(e)
    up.e = e
    return up.update()
  }

  async update_log (e) {
    let Update
    try {
      Update = (await import('../../other/update.js')).update
    } catch {
      return false
    }

    const updater = new Update()
    updater.e = this.e
    updater.reply = this.reply

    // ⚠️ getPlugin 是 async，漏 await 拿到 Promise 恒为 truthy，
    //    那个「插件目录不存在就跳过」的判断会失效
    if (await updater.getPlugin(PluginName)) {
      await this.e.reply(await updater.getLog(PluginName))
    }
    return true
  }
}

export default ValorantUpdate
