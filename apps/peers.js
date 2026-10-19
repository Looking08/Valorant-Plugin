/**
 * 同过场的玩家（`#瓦同场` / `#瓦隐藏战绩`）。
 *
 * 为什么能查到别人：掌瓦的战绩接口只认 scene，而每个人自己的 scene 会被
 * 服务端发给同场十个人（记分板每行都带）。App 里「点队友头像看战绩」就是这么实现的。
 * 陌生人查不到 —— 掌瓦没有按昵称搜人的接口，试过，服务端连表都没有。
 */
import { listPeers, hidePeer } from '#utils'

const NOTE = [
  '',
  '陌生人查不到：掌瓦没有按昵称搜人的接口，只认登录态。',
  '对方在掌瓦里开了「战绩列表隐私 · 仅自己可见」也会查不到，这是他的设置，不是插件坏了。'
].join('\n')

function when (ts) {
  if (!ts) return '未知'
  const days = Math.floor((Date.now() - ts) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

export class ValorantPeers extends plugin {
  constructor () {
    super({
      name: '瓦插件_同场',
      dsc: '同过场的玩家（查别人的战绩 / 关掉自己的可见性）',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?瓦(隐藏|关闭)战绩[\\s\\S]*$', fnc: 'hide' },
        { reg: '^#?瓦同场[\\s\\S]*$', fnc: 'list' }
      ]
    })
  }

  async list (e) {
    let peers
    try {
      peers = await listPeers(e.user_id)
    } catch (error) {
      await e.reply(`连不上战绩网关：${error.message || '未知原因'}`)
      return true
    }

    if (!peers?.length) {
      await e.reply(['还没有收录任何同过场的人。', '', '拿主账号打几局，或者查一次自己的战绩，索引就会自动建起来。'].join('\n'))
      return true
    }

    const top = peers.slice(0, 30)
    const lines = top.map((p, i) => `${String(i + 1).padStart(2)}  ${p.name}  ${when(p.seenAt)}`)
    const more = peers.length > top.length ? `\n……还有 ${peers.length - top.length} 人` : ''

    await e.reply([
      `收录了 ${peers.length} 个同过场的人：`,
      lines.join('\n'),
      more,
      '',
      '直接发：#瓦战绩 <昵称>  就能查他的最近战绩。',
      NOTE
    ].join('\n'))
    return true
  }

  async hide (e) {
    const name = String(e.msg || '').replace(/^#?瓦(隐藏|关闭)战绩/, '').trim()
    try {
      const data = await hidePeer(e.user_id, name)
      if (!data?.hidden) {
        await e.reply(name
          ? `没在同场索引里找到「${name}」。发 #瓦同场 看看现在收录了谁。`
          : '你在同场索引里没有记录，可能是主账号还没跟你同过场。')
      } else {
        await e.reply([
          `已关掉 ${data.hidden} 条记录的可见性${name ? `（${name}）` : '（你自己）'}。`,
          '',
          '之后别人再查，会提示「查不了这个人」。想恢复的话再抓一次包重新导入即可。'
        ].join('\n'))
      }
    } catch (error) {
      await e.reply(`连不上战绩网关：${error.message || '未知原因'}`)
    }
    return true
  }
}

export default ValorantPeers
