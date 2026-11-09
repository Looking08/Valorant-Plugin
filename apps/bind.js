/**
 * 账号管理（`#瓦绑定` / `#瓦切换` / `#瓦删除` / `#瓦账号`）。
 *
 * 存储格式见 utils/store.js —— 一个 QQ 号可以绑多个账号，用 `#瓦切换` 换当前生效的那个。
 *
 * ## 三种绑定方式（按识别顺序）
 *
 *   1. **掌瓦号**（9 位数字，例 `42035871`）—— 和王者营地 ID 一个用法。
 *      掌瓦号码本身当不了钥匙（接口只认登录态里的 scene），所以这里做的是
 *      「号码 → 某份登录态」的本地登记，详见 utils/campid.js。
 *   2. **序号**（`#瓦绑定 1`）—— 从掌瓦返回的真实账号列表里挑，最稳。
 *   3. **名称 / 名称#标签** —— 国际服 Riot ID，或掌瓦昵称（只有同过场的人才认）。
 *
 * ⚠️ 数字既可能是序号也可能是掌瓦号：**先按长度分流**（8~10 位 = 号，其余 = 序号），
 *    不然 `#瓦绑定 42035871` 会被当成「第 4 亿个账号」直接回「序号要在 1~N 之间」。
 */
import {
  getUserInfo,
  saveUserInfo,
  formatAccountList,
  parseRiotId,
  searchAccount,
  boundAccounts,
  credentialStatus,
  safeUser,
  normalizeCampId,
  findCampId,
  listCampIds,
  registerCampId,
  removeCampId
} from '#utils'

const BIND_TUTORIAL = [
  '绑定格式（三种都行）：',
  '· #瓦绑定 42035871        掌瓦号（App 里「我的 → 设置 → 编辑资料 → 掌瓦号」，9 位数字）',
  '· #瓦绑定 1               从「#瓦可选账号」里挑第几个，最稳',
  '· #瓦绑定 张三#1234       国际服 Riot ID；国服掌瓦没有标签，直接写昵称',
  '',
  '掌瓦号和王者营地 ID 的用法一样，但有一条限制：',
  '**这个号必须先有人扫过一次码**（#瓦微信登录 / #瓦扫码登录）。',
  '掌瓦的接口只认登录态里的 scene，服务端不给「按号查人」的接口，也不返回掌瓦号 ——',
  '所以号码只能当索引，真正取数用的还是那份登录态。登录态 3 天过期，过期要重扫。'
].join('\n')

/** 掌瓦号绑定成功/失败时反复用到的一段说明 */
const CAMP_HINT = [
  '· 号码归属接口上没法校验，登记者写错了就会查到别人的数据，发现不对发 #瓦解除号 <号码>',
  '· 掌瓦登录态 3 天过期，过期后要那个号本人重新扫一次码'
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
        // 撤销掌瓦号登记：必须排在「#瓦删除 N」前面，而且只认 8~10 位数字
        // （`#瓦删除 1` 还是删第 1 个账号，别抢了它的活）
        { reg: '^#?瓦(解除|注销|撤销|删除|删)(掌瓦)?号\\s*\\d{8,10}$', fnc: 'unregister' },
        { reg: '^#?瓦认领\\s*\\d{8,10}$', fnc: 'claim' },
        { reg: '^#?瓦切换\\s*\\d+$', fnc: 'switch' },
        { reg: '^#?瓦删(除|绑)\\s*\\d+$', fnc: 'remove' },
        { reg: '^#?瓦(我的)?(账号|掌瓦号)$', fnc: 'list' }
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

    // 8~10 位纯数字 = 掌瓦号。**必须先判长度**：不然下面那个「纯数字 = 序号」
    // 的分支会把 `#瓦绑定 42035871` 当成「第 4 亿个账号」，回一句
    // 「序号要在 1 ~ N 之间」—— 这是最容易踩的一脚。
    const campId = normalizeCampId(raw)
    if (campId) {
      await this.bindCampId(e, campId)
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

  /** 写一条账号进用户表（掌瓦号 / 普通绑定共用，重复绑定 = 更新） */
  saveAccount (userId, record) {
    return saveUserInfo(userId, current => {
      const accounts = Array.isArray(current.accounts) ? current.accounts : []
      const key = String(record.id).toLowerCase()
      const exist = accounts.findIndex(a => String(a.id).toLowerCase() === key)

      if (exist >= 0) {
        accounts[exist] = { ...accounts[exist], ...record }
        return { ...current, accounts, current: exist }
      }
      accounts.push(record)
      return { ...current, accounts, current: accounts.length - 1 }
    })
  }

  /**
   * 按掌瓦号绑定。
   *
   * 号码本身不是钥匙（掌瓦接口只认登录态里的 scene），所以这里做两件事：
   *   · 号已经登记过 → 绑定到它那份登录态，查询时用那份登录态取数；
   *   · 号没登记   → 只有「自己已经登录过」才能登记，登记完顺手绑上。
   *
   * 号码归属接口侧校验不了（掌瓦压根不返回这个字段），只能靠登记者声明 +
   * 事后可撤销 —— 这是这个功能唯一诚实的做法，别偷偷假装校验过。
   */
  async bindCampId (e, campId) {
    const me = safeUser(e.user_id)
    const record = findCampId(campId)

    if (record) {
      if (record.public === false && String(record.owner || '') !== me) {
        await e.reply(`掌瓦号 ${campId} 的登记者把这个号设成不公开了，换个别的方式查吧。`)
        return true
      }

      const status = await credentialStatus(record.user).catch(() => null)
      if (!status) {
        await e.reply('连不上战绩网关，读不到这个号的登录态。先确认网关在跑（插件目录下 pnpm bridge）。')
        return true
      }
      if (!status.bound || status.usable === false) {
        await e.reply([
          `掌瓦号 ${campId}${record.name ? `（${record.name}）` : ''} 登记过，但那份登录态已经不能用了。`,
          '',
          '掌瓦的票据固定 3 天到期（服务端限制，插件改不了），要这个号本人重新扫一次：',
          '  · #瓦微信登录    或    #瓦扫码登录',
          `扫完再发一次 #瓦绑定 ${campId} 就恢复了。`
        ].join('\n'))
        return true
      }

      const info = this.saveAccount(e.user_id, {
        id: campId,
        name: record.name || campId,
        tag: '',
        region: '',
        note: '掌瓦号',
        campUser: record.user
      })

      await e.reply([
        `绑定成功：掌瓦号 ${campId}${record.name ? `（${record.name}）` : ''}`,
        '（用的是这个号登记的那份登录态，可以直接查了）',
        '',
        formatAccountList(info),
        '',
        String(record.owner || '') === me || e.isMaster
          ? CAMP_HINT
          : `这个号登记在别人名下。如果这就是你自己的号，发 #瓦认领 ${campId} 改成用你的登录态。\n${CAMP_HINT}`
      ].join('\n'))
      return true
    }

    // ---- 没登记过 ----
    const status = await credentialStatus(e.user_id).catch(() => null)
    if (!status) {
      await e.reply('连不上战绩网关，没法确认你登录过没有。先确认网关在跑（插件目录下 pnpm bridge）。')
      return true
    }
    if (!status.bound) {
      await e.reply([
        `这个机器人上还没有掌瓦号 ${campId} 的登录态，查不了。`,
        '',
        '掌瓦和王者营地不一样：营地 ID 本身就是钥匙，掌瓦的接口只认登录态里的 scene，',
        '服务端既不返回掌瓦号，也没有「按号查人」的接口。所以号得先扫一次码。',
        '',
        '  · 先发 #瓦微信登录（或 #瓦扫码登录），用这个号扫一下',
        `  · 扫完再发 #瓦绑定 ${campId}`,
        '',
        `扫完这个号就登记在机器人上了，之后任何人发 #瓦绑定 ${campId} 都能查（和营地 ID 一样）。`
      ].join('\n'))
      return true
    }

    const name = status.role?.name || ''
    registerCampId(campId, { user: me, name, owner: me })

    const info = this.saveAccount(e.user_id, {
      id: campId,
      name: name || campId,
      tag: '',
      region: '',
      note: '掌瓦号',
      campUser: me
    })

    await e.reply([
      `已登记并绑定：掌瓦号 ${campId}${name ? `（${name}）` : ''}`,
      '（用的是你刚才登录的那份登录态）',
      '',
      formatAccountList(info),
      '',
      CAMP_HINT
    ].join('\n'))
    return true
  }

  /**
   * 认领一个已经被别人登记的号（号主本人用）。
   *
   * 为什么需要这条：登记只能声明、无法校验，先发的人就把号占了。
   * 真正的号主「重新绑定」时会看到号已在别人名下 —— 那条路是给「查」用的，
   * 不会覆盖登记。想拿回登记权，发这条。
   *
   * 前提是自己有可用登录态：没扫过码的人不能靠一条指令把别人的号抢走。
   */
  async claim (e) {
    const campId = normalizeCampId(e.msg.match(/\d{8,10}/)?.[0] || '')
    const me = safeUser(e.user_id)
    const record = campId ? findCampId(campId) : null

    if (!campId) {
      await e.reply('用法：#瓦认领 42035871')
      return true
    }

    const status = await credentialStatus(e.user_id).catch(() => null)
    if (!status?.bound) {
      await e.reply([
        `认领 ${campId} 要先有自己的登录态（不然没法确认这个号该用哪份数据）。`,
        '  · 先发 #瓦微信登录（或 #瓦扫码登录）',
        `  · 再发 #瓦认领 ${campId}`
      ].join('\n'))
      return true
    }

    const name = status.role?.name || record?.name || ''
    registerCampId(campId, { user: me, name, owner: me })

    const info = this.saveAccount(e.user_id, {
      id: campId,
      name: name || campId,
      tag: '',
      region: '',
      note: '掌瓦号',
      campUser: me
    })

    await e.reply([
      record
        ? `已把掌瓦号 ${campId} 的登记改到你名下${name ? `（${name}）` : ''}。`
        : `掌瓦号 ${campId} 之前没登记过，这次直接登记到你名下了${name ? `（${name}）` : ''}。`,
      '之后这个号查的就是你这份登录态。',
      '',
      formatAccountList(info)
    ].join('\n'))
    return true
  }

  /** 撤销掌瓦号登记（只能撤自己登记的，主人例外） */
  async unregister (e) {
    const campId = normalizeCampId(e.msg.match(/\d{8,10}/)?.[0] || '')
    const me = safeUser(e.user_id)
    const record = campId ? findCampId(campId) : null

    if (!record) {
      await e.reply(`掌瓦号 ${campId || '（没读到）'} 没登记过，不用撤。`)
      return true
    }
    if (String(record.owner || '') !== me && !e.isMaster) {
      await e.reply(`掌瓦号 ${campId} 是别人登记的，只有登记人或机器人主人能撤销。`)
      return true
    }

    removeCampId(campId)
    const info = saveUserInfo(e.user_id, current => {
      const accounts = (current.accounts || []).filter(a => String(a.id) !== campId)
      const cur = Math.min(Number(current.current) || 0, Math.max(0, accounts.length - 1))
      return { accounts, current: Math.max(0, cur) }
    })

    await e.reply([
      `已撤销掌瓦号 ${campId} 的登记${record.name ? `（${record.name}）` : ''}，绑定列表里也删掉了。`,
      '那份登录态还在，想恢复就重新发 #瓦绑定 ' + campId + '。',
      '',
      info.accounts.length ? formatAccountList(info) : '现在没有任何绑定了。'
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
    const registered = listCampIds(safeUser(e.user_id))

    if (!info.accounts?.length && !registered.length) {
      await e.reply(`还没绑定账号。\n\n${BIND_TUTORIAL}`)
      return true
    }

    const lines = []
    if (info.accounts?.length) {
      lines.push('【已绑定的账号】', formatAccountList(info), '', '切换：#瓦切换 序号')
    } else {
      lines.push('还没有绑定账号。')
    }

    if (registered.length) {
      lines.push('', '【你登记过的掌瓦号】')
      for (const r of registered) {
        lines.push(`· ${r.campId}${r.name ? `（${r.name}）` : ''}${r.public === false ? ' · 不公开' : ''}`)
      }
      lines.push('撤销：#瓦解除号 <号码>')
    }

    await e.reply(lines.join('\n'))
    return true
  }
}

export default ValorantBind
