/**
 * 帮助（`#瓦帮助`）。
 *
 * 出一张图 + 一段兜底文本：有人的机器人硬盘 / Chromium 不可靠，
 * 出图失败时至少还能看到指令列表（GOK 的 help.js 也做了同样的兜底）。
 */
import { replyImage } from '#utils'

/** ⚠️ 新增指令时同步改这里 —— 用户找不到 ≡ 功能不存在 */
const SECTIONS = [
  {
    icon: '01',
    title: '账号管理',
    desc: '绑定后不用每次打 ID',
    items: [
      { cmd: '#瓦绑定', args: '名称#标签 [大区]', desc: '绑定 Riot ID，例：#瓦绑定 张三#1234 na' },
      { cmd: '#瓦切换', args: '序号', desc: '切换当前使用的账号' },
      { cmd: '#瓦删除', args: '序号', desc: '删掉一个绑定的账号' },
      { cmd: '#瓦账号', args: '', desc: '看已绑定的列表' }
    ]
  },
  {
    icon: '02',
    title: '登录态',
    desc: '一人一份，各查各的',
    items: [
      { cmd: '#瓦扫码登录', args: '', desc: '机器人出码，手机 QQ 扫一下就好，不用抓包' },
      { cmd: '#瓦登录', args: '', desc: '看登录状态；扫码走不通时会给出抓包步骤' },
      { cmd: '#瓦导入', args: '<粘贴 cURL>', desc: '抓包 App 里复制 cURL 直接粘上来，机器人自己拆 cookie 和 scene' },
      { cmd: '#瓦登录状态', args: '', desc: '看自己的登录态是否还有效' },
      { cmd: '#瓦退出登录', args: '', desc: '删掉自己的登录态（换号时用）' }
    ]
  },
  {
    icon: '03',
    title: '数据面板',
    desc: '一眼看完整个赛季',
    items: [
      { cmd: '#瓦面板', args: '[名称#标签]', desc: '生涯概览：段位 / KDA / ACS / 爆头率 / 常用特工' },
      { cmd: '#瓦面板', args: '@群友', desc: '只能查到自己那份登录态的角色（掌瓦没有按名查人）' }
    ]
  },
  {
    icon: '04',
    title: '战绩查询',
    desc: '列表 → 详情两步',
    items: [
      { cmd: '#瓦战绩', args: '[条数]', desc: '最近战绩列表，默认 10 场' },
      { cmd: '#瓦战绩', args: '20', desc: '拉最近 20 场' },
      { cmd: '#瓦战绩详情', args: '序号', desc: '看列表中第几局的详细数据（含双方十人）；「#瓦对局详细 9」这类说法也认' }
    ]
  },
  {
    icon: '05',
    title: '同过场的人',
    desc: '掌瓦把每人的 scene 发给同场十人，所以打过就能查',
    items: [
      { cmd: '#瓦战绩', args: '<昵称>', desc: '查同过场那位的战绩。陌生人查不了 —— 掌瓦没有按昵称搜人的接口' },
      { cmd: '#瓦同场', args: '', desc: '看已经收录了谁' },
      { cmd: '#瓦隐藏战绩', args: '', desc: '关掉自己在索引里的可见性（对方开了隐私也会查不到）' }
    ]
  },
  {
    icon: '07',
    title: '枪械熟练度',
    desc: '你到底被哪把枪杀得最多',
    items: [
      { cmd: '#瓦枪械', args: '', desc: '按击杀数排序的默认视图' },
      { cmd: '#瓦枪械', args: '爆头', desc: '换排序口径：击杀 / 爆头 / 伤害 / 命中 / 回合' }
    ]
  },
  {
    icon: '08',
    title: '系统',
    desc: '排查与维护',
    items: [
      { cmd: '#瓦状态', args: '', desc: '检查网关和数据源通不通' },
      { cmd: '#瓦清缓存', args: '', desc: '清掉本地图片与静态数据缓存（主人）' },
      { cmd: '#瓦更新', args: '', desc: '更新插件（主人）' }
    ]
  }
]

export class ValorantHelp extends plugin {
  constructor () {
    super({
      name: '瓦插件_帮助',
      dsc: '无畏契约插件帮助',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?瓦(插件)?帮助$', fnc: 'help' }
      ]
    })
  }

  async help (e) {
    const ok = await replyImage(e, 'ValorantHelp', 'help.html', { sections: SECTIONS })
    if (!ok) await e.reply(textFallback())
    return true
  }
}

function textFallback () {
  return [
    '【无畏契约插件 · 指令】',
    '',
    ...SECTIONS.flatMap(s => [
      `— ${s.title} —`,
      ...s.items.map(i => `${i.cmd}${i.args ? ' ' + i.args : ''}：${i.desc}`),
      ''
    ]),
    '完整说明见插件 README'
  ].join('\n')
}

export default ValorantHelp
