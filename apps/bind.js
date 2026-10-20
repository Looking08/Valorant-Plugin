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
  searchAccount,
  boundAccounts
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

/**
 * 把掌瓦返回的真实账号列表排成可读的样子。
 *
 * 这份列表是掌瓦自己给的（`bind_relation_list`），认登录态不认昵称，
 * 所以上面写的名字一定是当前真正生效的那个 —— 比让用户回忆自己叫啥靠谱。
 */
function formatBoundList (list) {
  if (!list?.length) return '（这个登录态下没读到任何账号）'
  return list.map(a => {
    const src = a.thirdType === 2 ? '微信' : a.thirdType === 1 ? 'QQ' : ''
    // gameName 是游戏里的名字，name 是微信/QQ 昵称 —— 两者常常不是一回事，
    // 有游戏名就用它，昵称只作为补充说明，别拿昵称当账号名。
    const label = a.gameName || a.name
    const bits = []
    if (a.gameName && a.name && a.gameName !== a.name) bits.push(`${src}昵称 ${a.name}`)
    else if (src) bits.push(`${src}登录`)
    if (!a.verified) bits.push('未实名')
    return `${a.index}. ${label}${bits.length ? `（${bits.join(' · ')}）` : ''}`
  }).join('\n')
}

/** 读真实账号列表；读不到就把原因带出来，别只说「没有」 */
async function readBound (user) {
  try {
    return { list: await boundAccounts(user), why: '' }
  } catch (error) {
    return { list: [], why: error?.message || String(error) }
  }
}

export class ValorantBind extends plugin {
  constructor () {
    super({
      name: '瓦插件_账号管理',
      dsc: '无畏契约账号绑定与切换',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?瓦(可选账号|号源|真实账号)$', fnc: 'bound' },
        { reg: '^#?瓦绑定[\\s\\S]*$', fnc: 'bind' },
        { reg: '^#?瓦切换\\s*\\d+$', fnc: 'switch' },
        { reg: '^#?瓦删(除|绑)\\s*\\d+$', fnc: 'remove' },
        { reg: '^#?瓦(我的)?账号$', fnc: 'list' }
      ]
    })
  }

  /**
   * 列出这个登录态下真实能查的账号。
   *
   * 掌瓦没有「按昵称搜人」的接口，之前绑定全靠用户把名字打对 —— 打错了
   * （或者游戏里改过名）就只回一句「没认出来这是什么账号格式」，很折磨人。
   * 这份列表是掌瓦自己给的，名字和 scene 都是当前生效的，照着选就行。
   */
  async bound (e) {
    const { list, why } = await readBound(e.user_id)

    if (why) {
      await e.reply(`读不到真实账号列表：${why}\n\n${BIND_TUTORIAL}`)
      return true
    }
    if (!list.length) {
      await e.reply(`这个登录态下没读到绑定的游戏账号。\n\n${BIND_TUTORIAL}`)
      return true
    }

    await e.reply([
      '【这个登录态下真实能查的账号】',
      formatBoundList(list),
      '',
      '直接用：#瓦绑定 序号（例：#瓦绑定 1）'
    ].join('\n'))
    return true
  }

  /** 从真实账号列表里按序号挑一个绑上 */
  async bindByIndex (e, index) {
    const { list, why } = await readBound(e.user_id)

    if (why) {
      await e.reply(`读不到真实账号列表：${why}`)
      return true
    }
    if (!list.length) {
      await e.reply(`这个登录态下没读到账号。\n\n${BIND_TUTORIAL}`)
      return true
    }

    const picked = list.find(a => a.index === index)
    if (!picked) {
      await e.reply(`序号要在 1 ~ ${list.length} 之间哦：\n\n${formatBoundList(list)}`)
      return true
    }

    // 游戏名优先：bind_relation_list 给的 name 是微信昵称，拿它当账号名会绑错
    const label = picked.gameName || picked.name

    const info = saveUserInfo(e.user_id, current => {
      const accounts = Array.isArray(current.accounts) ? current.accounts : []
      const exist = accounts.findIndex(a => a.id.toLowerCase() === label.toLowerCase())
      // scene 存进 note：它是「查谁」的钥匙，后面排查问题时一眼能看见
      const record = { id: label, name: label, tag: '', region: '', note: `scene ${picked.scene}` }

      if (exist >= 0) {
        accounts[exist] = { ...accounts[exist], ...record }
        return { ...current, accounts, current: exist }
      }
      accounts.push(record)
      return { ...current, accounts, current: accounts.length - 1 }
    })

    await e.reply([
      `绑定成功：${label}`,
      '（名字来自掌瓦的账号列表，不用猜）',
      '',
      formatAccountList(info)
    ].join('\n'))
    return true
  }

  async bind (e) {
    const raw = e.msg.replace(/^#?瓦绑定/, '').trim()

    if (!raw) {
      const { list } = await readBound(e.user_id)
      await e.reply(list.length
        ? `${BIND_TUTORIAL}\n\n或者发 #瓦可选账号 看这个登录态下真实能查的号（这次读到了 ${list.length} 个）。`
        : BIND_TUTORIAL)
      return true
    }

    // 纯数字 = 从真实账号列表里挑第几个。这条比「猜昵称」稳得多。
    if (/^\d+$/.test(raw)) {
      await this.bindByIndex(e, Number(raw))
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
        // 认不出来的时候顺手把真实账号列表带出来。掌瓦没按昵称搜人的接口，
        // 名字对不上就卡在这儿 —— 直接告诉他现在到底叫啥，比让他回忆强。
        const { list } = await readBound(e.user_id)
        const hint = list.length
          ? `\n\n这个登录态下真实能查的是这些（发 #瓦绑定 序号 就能绑）：\n${formatBoundList(list)}`
          : ''

        // 之前这里一律回「没认出来这是什么账号格式」，可网关没起来的提示一模一样，
        // 会让人以为自己名字写错了。分开说。
        await e.reply(why
          ? `没能认出「${raw}」，但原因不是格式：\n${why}${hint}`
          : `没认出来这是什么账号格式：${raw}\n\n${BIND_TUTORIAL}${hint}`)
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
