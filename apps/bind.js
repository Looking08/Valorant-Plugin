/**
 * 账号管理（`#瓦绑定` / `#瓦切换` / `#瓦删除` / `#瓦账号`）。
 *
 * 存储格式见 utils/store.js —— 一个 QQ 号可以绑多个 Riot ID，用 `#瓦切换` 换当前生效的那个。
 * 和平精英插件是「绑定营地 ID」，这里对应「绑定 名称#标签」，逻辑基本照着写，
 * 只把 ID 校验从「纯数字」换成了 riot id 格式。
 */
import {
  getUserInfo,
  saveUserInfo,
  formatAccountList,
  parseRiotId,
  searchAccount
} from '#utils'

const BIND_TUTORIAL = [
  '绑定格式：#瓦绑定 游戏名称#标签',
  '例：#瓦绑定 张三#1234',
  '',
  '· 「#」前后不要有空格也可以识别',
  '· 标签就是游戏里名字后面那几个字符，不是 QQ 尾号',
  '· 国际服 / 国服如果想指定大区，在后面加一句：#瓦绑定 张三#1234 na',
  '· 国服掌瓦（手游）没有 #标签，直接写昵称就行：#瓦绑定 苦橘甘来'
].join('\n')

export class ValorantBind extends plugin {
  constructor () {
    super({
      name: '瓦插件_账号管理',
      dsc: '无畏契约账号绑定与切换',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?瓦绑定[\\s\\S]*$', fnc: 'bind' },
        { reg: '^#?瓦切换\\s*\\d+$', fnc: 'switch' },
        { reg: '^#?瓦删(除|绑)\\s*\\d+$', fnc: 'remove' },
        { reg: '^#?瓦(我的)?账号$', fnc: 'list' }
      ]
    })
  }

  async bind (e) {
    const raw = e.msg.replace(/^#?瓦绑定/, '').trim()

    if (!raw) {
      await e.reply(BIND_TUTORIAL)
      return true
    }

    const region = raw.match(/\b(ap|na|eu|kr|br|latam|cn)\b/i)?.[1]?.toLowerCase() || ''
    const parsed = parseRiotId(raw)

    /** 要存进库里的账号（`{id, name, tag}`） */
    let target = parsed
    /** 数据源确认「这个号存在」时为 true */
    let verified = false
    /** 走的是「让数据源认昵称」那条路（没有 # 的情况） */
    let guessed = false

    if (target) {
      // 顺手验一下这个号能不能查到 —— 绑一个不存在的号比没绑更让人困惑
      try {
        verified = !!(await searchAccount(target.id, region, e.user_id))?.puuid
      } catch {
        // 验证失败不影响绑定：可能是网关临时抽风，不是账号有问题
        verified = false
      }
    } else {
      // 没有 # 不一定是用户写错：国服掌瓦（手游）根本没有标签，昵称就是唯一标识。
      // 这种情况先让数据源认一下人 —— 认出来就用它返回的规范 id，
      // 认不出来再回教程（这样国际服用户漏了标签还能看到正确的格式提示）。
      const guess = raw.replace(/\b(ap|na|eu|kr|br|latam|cn)\b/i, '').trim()
      /** 认号失败的真实原因（网关挂了 / 超时 / 上游报错），别和「格式不对」混为一谈 */
      let why = ''
      try {
        const found = guess ? await searchAccount(guess, region, e.user_id) : null
        if (found?.id) {
          target = { id: found.id, name: found.name || guess, tag: found.tag || '' }
          verified = !!found.puuid
          guessed = true
        }
      } catch (error) {
        target = null
        why = error?.message || String(error)
      }

      if (!target) {
        // 之前这里一律回「没认出来这是什么账号格式」，可网关没起来的提示一模一样，
        // 会让人以为自己名字写错了。分开说。
        await e.reply(why
          ? `没能认出「${raw}」，但原因不是格式：\n${why}`
          : `没认出来这是什么账号格式：${raw}\n\n${BIND_TUTORIAL}`)
        return true
      }
    }

    const info = saveUserInfo(e.user_id, current => {
      const accounts = Array.isArray(current.accounts) ? current.accounts : []
      const exist = accounts.findIndex(a => a.id.toLowerCase() === target.id.toLowerCase())
      const record = { ...target, region, note: '' }

      if (exist >= 0) {
        accounts[exist] = { ...accounts[exist], ...record }
        return { ...current, accounts, current: exist }
      }
      accounts.push(record)
      return { ...current, accounts, current: accounts.length - 1 }
    })

    await e.reply([
      `绑定成功：${target.id}${region ? `（${region}）` : ''}`,
      guessed
        ? '（这个数据源没有 #标签，已按昵称认出的账号存下）'
        : verified ? '（已校验：数据源能查到这个号）' : '（未校验：网关不可用或查无此号，不影响绑定）',
      '',
      formatAccountList(info)
    ].join('\n'))
    return true
  }

  async switch (e) {
    const index = Number(e.msg.match(/\d+$/)[0]) - 1
    const { info } = getUserInfo(e.user_id)

    if (!info.accounts?.length) {
      await e.reply(`还没绑定过账号。\n\n${BIND_TUTORIAL}`)
      return true
    }
    if (index < 0 || index >= info.accounts.length) {
      await e.reply(`序号要在 1 ~ ${info.accounts.length} 之间哦`)
      return true
    }

    const updated = saveUserInfo(e.user_id, current => ({ ...current, current: index }))
    await e.reply(`已切换到：${updated.accounts[index].id}\n\n${formatAccountList(updated)}`)
    return true
  }

  async remove (e) {
    const index = Number(e.msg.match(/\d+$/)[0]) - 1
    const { info } = getUserInfo(e.user_id)

    if (!info.accounts?.length) {
      await e.reply('当前没有绑定任何账号。')
      return true
    }
    if (index < 0 || index >= info.accounts.length) {
      await e.reply(`序号要在 1 ~ ${info.accounts.length} 之间哦`)
      return true
    }

    const removed = info.accounts[index]
    const updated = saveUserInfo(e.user_id, current => {
      const accounts = current.accounts.filter((_, i) => i !== index)
      const cur = current.current > index ? current.current - 1 : Math.min(current.current, accounts.length - 1)
      return { accounts, current: Math.max(0, cur) }
    })

    await e.reply(`已删除：${removed.id}\n\n${updated.accounts.length ? formatAccountList(updated) : '现在没有任何绑定了。'}`)
    return true
  }

  async list (e) {
    const { info } = getUserInfo(e.user_id)
    if (!info.accounts?.length) {
      await e.reply(`还没绑定账号。\n\n${BIND_TUTORIAL}`)
      return true
    }
    await e.reply(`【已绑定的无畏契约账号】\n${formatAccountList(info)}\n\n切换：#瓦切换 序号`)
    return true
  }
}

export default ValorantBind
