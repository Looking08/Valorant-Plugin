/**
 * 锅巴（Guoba-Plugin）适配
 *
 * 只在插件根目录放这个文件，锅巴启动/刷新插件列表时会自动扫描注册。
 * 面板里可以：选出图主题（亮色 / 深色）、挑背景图、调纱浓度。
 *
 * 写配置走 `yaml` 的 Document API：只动 render 下三个键，
 * 用户手写在 config/config/config.yaml 里的其他内容和注释全部保留；
 * 改完由 components/Config.js 的 fs.watch 热更新，不用重启。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginPath } from '#components'
import { view, listBackgrounds, bgDir } from '#utils'

let YAML = null
try {
  YAML = (await import('yaml')).default
} catch {
  YAML = null
}

/** 用户配置文件（锅巴只写这一份，模板永远不碰） */
const USER_CONFIG = path.join(PluginPath, 'config', 'config', 'config.yaml')

/**
 * 把 patch 写到用户配置（只有一层 section → key），保留注释与其他键。
 * @param {object} patch 形如 { render: { theme: 'dark' } }，只写出现的键
 */
function patchUserConfig (patch) {
  if (!YAML) throw new Error('缺少依赖 yaml（插件目录 pnpm install）')

  fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true })
  if (!fs.existsSync(USER_CONFIG)) {
    // 理论上插件启动时 Config.init() 已经从模板复制过了；万一没有，这里补
    const template = path.join(PluginPath, 'config', 'default_config', 'config.yaml')
    fs.copyFileSync(template, USER_CONFIG)
  }

  const doc = YAML.parseDocument(fs.readFileSync(USER_CONFIG, 'utf8'))
  for (const [section, values] of Object.entries(patch)) {
    for (const [key, value] of Object.entries(values)) {
      doc.setIn([section, key], value)
    }
  }
  fs.writeFileSync(USER_CONFIG, doc.toString())
}

export const supportGuoba = () => {
  const cfg = view()
  const bgs = listBackgrounds()

  // 背景图下拉：随机 / 关闭 / 目录里每张图一项
  const backgroundOptions = [
    { label: '随机（目录里挑一张）', value: 'all' },
    { label: '不使用背景图（纯色底）', value: 'false' },
    ...bgs.map(f => ({ label: `固定：${f}`, value: f }))
  ]

  return {
    pluginInfo: {
      name: 'valorant-plugin',
      title: '无畏契约战绩',
      description: '面板 / 战绩 / 单局详情 / 枪械熟练度，微信·QQ 扫码登录，掌瓦号绑定',
      author: 'Looking08',
      authorLink: 'https://github.com/Looking08',
      link: 'https://github.com/Looking08/Valorant-Plugin',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:crosshairs',
      iconColor: '#d8354a'
    },
    configInfo: {
      schemas: [
        { component: 'SOFT_GROUP_BEGIN', label: '出图主题' },
        {
          field: 'theme',
          label: '主题配色',
          component: 'Select',
          bottomHelpMessage: '亮色 = 浅灰底白卡片（默认）；深色 = VALORANT 客户端配色。改完下一张图生效',
          componentProps: {
            options: [
              { label: '亮色（默认）', value: 'light' },
              { label: '深色（VALORANT 客户端风）', value: 'dark' }
            ]
          }
        },
        { component: 'SOFT_GROUP_BEGIN', label: '出图背景' },
        {
          field: 'background',
          label: '背景图',
          component: 'Select',
          bottomHelpMessage: bgs.length
            ? `图丢进 ${bgDir()} 立即生效；新加的图刷新一下本页就会出现`
            : `目录里还没有图：往 ${bgDir()} 丢几张（jpg/png/webp 都行），刷新本页即可选择`,
          componentProps: {
            options: backgroundOptions
          }
        },
        {
          field: 'veil',
          label: '纱浓度',
          component: 'InputNumber',
          bottomHelpMessage: '盖在背景图上的纱：0 = 图原样（字可能看不清），1 = 纯色底（图看不见）。字糊了调大，图想明显调小',
          componentProps: {
            min: 0,
            max: 1,
            step: 0.05,
            placeholder: '0.72'
          }
        }
      ],

      // 前端填充表单
      getConfigData () {
        const cur = view()
        return {
          theme: cur.theme,
          background: cur.background === false ? 'false' : String(cur.background),
          veil: cur.veil
        }
      },

      // 前端点保存
      setConfigData (data, { Result }) {
        try {
          const patch = { render: {} }
          if (data.theme !== undefined) {
            patch.render.theme = data.theme === 'dark' ? 'dark' : 'light'
          }
          if (data.background !== undefined) {
            patch.render.background = data.background === 'false' || data.background === false
              ? false
              : String(data.background)
          }
          if (data.veil !== undefined) {
            const v = Number(data.veil)
            patch.render.veil = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.72
          }
          patchUserConfig(patch)
          return Result.ok({}, '保存成功，下一张出图生效~')
        } catch (err) {
          return Result.error(`保存失败：${err.message}`)
        }
      }
    }
  }
}

export default supportGuoba
