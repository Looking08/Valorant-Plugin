/**
 * 战绩列表（`#瓦战绩`）与单局详情（`#瓦战绩详情`）。
 *
 * 列表里的每一项都有一个序号，`#瓦战绩详情 3` 就是拉第 3 局。
 * 序号对应关系存在内存里 **30 分钟**（`lastResults`），不用复杂的上下文：
 * 群聊里 @ 别人、换人查询会很频繁，上下文状态留久了容易串号。
 */
import {
  getMatches,
  getMatch,
  agentOf,
  mapOf,
  resolveAccount,
  NeedBind,
  asset,
  assets,
  GatewayError,
  pct01,
  round,
  duration,
  dateTime,
  timeAgo,
  resultText,
  resultClass,
  modeText,
  regionText,
  display,
  replyImage
} from '#utils'

/** userId → { list, expire }：每人一份，互不干扰 */
const lastResults = new Map()

function setLast (userId, list) {
  lastResults.set(String(userId), { list, expire: Date.now() + 30 * 60 * 1000 })
}

function getLast (userId) {
  const hit = lastResults.get(String(userId))
  if (!hit) return null
  if (Date.now() > hit.expire) {
    lastResults.delete(String(userId))
    return null
  }
  return hit.list
}

/** 把网关返回的原始战绩 enrich 成模板能直接用的一组数据 */
async function buildList (items) {
  const enriched = await Promise.all(items.map(async (m, i) => {
    const [agent, map] = await Promise.all([agentOf(m.agentId), mapOf(m.mapId)])
    return {
      index: i + 1,
      matchId: m.matchId,
      agent: m.agentName || agent.displayName || '未知',
      // 数据源自带图标时优先用它（掌瓦的特工 id 是数字，valorant-api 查不到）
      agentIcon: m.agentIcon || agent.displayIconSmall || agent.displayIcon || '',
      agentRoleBg: agent.background || '',
      map: m.mapName || map.displayName || '未知地图',
      mapIcon: m.mapIcon || map.listViewIcon || map.splash || '',
      mode: modeText(m.mode),
      resultText: resultText(m.result),
      cls: resultClass(m.result),
      score: m.score || `${m.scoreSelf ?? '?'}-${m.scoreEnemy ?? '?'}`,
      kills: m.kills ?? 0,
      deaths: m.deaths ?? 0,
      assists: m.assists ?? 0,
      kd: round(m.kd ?? 0, 2),
      // ACS 为 0 基本只可能是「数据源没给」（掌瓦的团队激战就没有 score），
      // 这种情况写「—」而不是 0
      acs: m.acs ? round(m.acs, 0) : '—',
      // 掌瓦的列表接口只有 KDA / ACS，没有 ADR、爆头率和时长。
      // 缺就写「—」：显示 0 会让人以为这局一枪没打中。
      adr: m.adr ? round(m.adr, 0) : '—',
      headshotText: m.headshotRate ? pct01(m.headshotRate) : '—',
      rounds: m.roundsPlayed ?? 0,
      lengthText: m.durationSec ? duration(m.durationSec) : '—',
      timeText: timeAgo(m.startedAt),
      dateText: dateTime(m.startedAt),
      // 本局全场名次（1 = MVP）。数据源没给就是 0，模板据此不显示徽章，
      // 绝不按「ACS 挺高」自己猜一个 —— 猜错的 MVP 比没有更糟
      mvp: m.mvp === true,
      rankInMatch: Number(m.rankInMatch) > 0 ? Number(m.rankInMatch) : 0
    }
  }))

  return assets(enriched, 'agentIcon', 'agentIcon').then(list =>
    Promise.all(list.map(async item => ({ ...item, mapIcon: await asset(item.mapIcon) })))
  )
}

export class ValorantMatches extends plugin {
  constructor () {
    super({
      name: '瓦插件_战绩',
      dsc: '无畏契约战绩列表与详情',
      event: 'message',
      priority: 1000,
      rule: [
        // ⚠️ 详情必须排在列表**前面**，而且列表正则要用负向断言把「详情/单局/对局」排掉：
        //    `^#?瓦战绩[\s\S]*$` 会把「#瓦战绩详情 2」整条吃掉（实测踩过），
        //    于是用户点详情永远收到一张列表图。云崽按 rule 顺序取第一个命中的。
        //
        // 这条正则把同一件事的几种叫法都收了：「战绩详情 / 对局详细 / 单局数据」。
        // 群里没人会严格照着文档打字，`#瓦对局详细9` 是最常见的说法 ——
        // 原来只认「战绩(详情|单局|对局)」，这种写法会被列表规则吃掉，
        // 用户发了半天以为插件坏了。
        { reg: '^#?瓦(?:(?:战绩|单局)?(?:详情|详细|数据)|对局(?:详情|详细)?)\\s*\\d+$', fnc: 'detail' },
        { reg: '^#?瓦战绩(?!详情|单局|对局)[\\s\\S]*$', fnc: 'matches' }
      ]
    })
  }

  async matches (e) {
    const raw = e.msg.replace(/^#?瓦战绩/, '').trim()
    const cfg = display()

    let account
    try {
      account = resolveAccount(e, raw).account
    } catch (error) {
      if (error instanceof NeedBind) await e.reply(error.message)
      else throw error
      return true
    }

    // 参数里可能带条数（`#瓦战绩 20`），也可能带 name#tag
    const countMatch = raw.match(/(?:^|\s)(\d{1,2})(?:\s|$)/)
    const count = Math.min(
      countMatch ? Number(countMatch[1]) : cfg.matchesDefault,
      cfg.matchesMax
    )

    await e.reply(`正在拉取 ${account.id} 的最近 ${count} 场战绩，稍等…`).catch(() => {})
    if (count > 10) await e.reply('（一次拉太多会比较慢，别催 ~）').catch(() => {})

    let data
    try {
      data = await getMatches({ account: account.id, region: account.region, count, user: e.user_id })
    } catch (error) {
      if (error instanceof GatewayError) await e.reply(error.message)
      else {
        logger.error(`[瓦插件] 战绩查询失败：${error.message}`)
        await e.reply('查询失败了，详情看日志。')
      }
      return true
    }

    const rawList = data.list || []
    if (!rawList.length) {
      await e.reply(`没查到 ${account.id} 的近期战绩。\n可能是一局没打，或者数据源看不到（对方开了隐私另说）。`)
      return true
    }

    const list = await buildList(rawList)
    setLast(e.user_id, rawList)

    const acc = data.account || {}
    const summary = data.summary || {}

    await replyImage(e, 'ValorantMatches', 'matches.html', {
      account: {
        id: acc.id || account.id,
        region: regionText(acc.region || account.region),
        card: await asset(acc.card?.small || ''),
        name: acc.name || ''
      },
      list,
      count: list.length,
      summary: {
        matches: summary.matches ?? list.length,
        wins: summary.wins ?? list.filter(i => /win/.test(i.cls)).length,
        losses: summary.losses ?? list.filter(i => /lose/.test(i.cls)).length,
        winRateText: pct01(summary.winRate),
        acs: round(summary.acs, 0),
        kd: round(summary.kd, 2)
      },
      hasMore: !!summary.hasMore
    })
    return true
  }

  async detail (e) {
    const index = Number(e.msg.match(/\d+$/)[0]) - 1
    const cache = getLast(e.user_id)

    if (!cache) {
      await e.reply('先发一次 #瓦战绩 拿到列表，再对序号查详情哦。')
      return true
    }
    if (index < 0 || index >= cache.length) {
      await e.reply(`序号要在 1 ~ ${cache.length} 之间。`)
      return true
    }

    const brief = cache[index]
    let data
    try {
      data = await getMatch(brief.matchId, brief.accountId || '', e.user_id)
    } catch (error) {
      if (error instanceof GatewayError) await e.reply(error.message)
      else {
        logger.error(`[瓦插件] 战绩详情失败：${error.message}`)
        await e.reply('查询失败了，详情看日志。')
      }
      return true
    }

    // 「我是哪一队」：数据源给就用它的，没给就看哪条 isSelf。
    // ⚠️ Blue / Red 是阵营不是敌我 —— 我在红队时，红才是我方。
    const selfRow = (data.players || []).find(p => p.isSelf)
      || (data.players || []).find(p => p.id && p.id === brief.accountId)
    const declared = String(data.myTeam || '').toLowerCase()
    const myTeam = declared === 'blue' || declared === 'red'
      ? declared
      : (String(selfRow?.team || '').toLowerCase() === 'red' ? 'red' : 'blue')

    const players = await Promise.all((data.players || []).map(async p => {
      const agent = await agentOf(p.agentId)
      const team = String(p.team || '').toLowerCase() === 'red' ? 'red' : 'blue'
      return {
        id: p.id || `${p.name || '玩家'}#${p.tag || ''}`,
        agent: p.agentName || agent.displayName || '未知',
        agentIcon: p.agentIcon || agent.displayIconSmall || '',
        roleBg: agent.background || '',
        team,
        side: team === myTeam ? 'mine' : 'enemy',
        // 模板靠它区分「我」和「队友」两个标签，漏传会全显示成「队友」
        isSelf: !!p.isSelf,
        kills: p.kills ?? 0,
        deaths: p.deaths ?? 0,
        assists: p.assists ?? 0,
        kd: round(p.kd ?? 0, 2),
        acs: round(p.acs ?? 0, 0),
        econ: p.econ ?? 0,
        headshots: p.headshots ?? 0,
        headshotText: pct01(p.headshotRate),
        firstBloods: p.firstBloods ?? 0,
        plants: p.plants ?? 0,
        defuses: p.defuses ?? 0,
        rankName: p.rank?.tierName || '',
        rankIcon: p.rank?.icon || ''
      }
    }))

    const map = await mapOf(data.mapId || brief.mapId)

    await replyImage(e, 'ValorantMatchDetail', 'matchDetail.html', {
      matchId: data.matchId || brief.matchId,
      mapName: data.mapName || map.displayName || '',
      mapIcon: await asset(data.mapIcon || map.splash || map.listViewIcon || ''),
      mode: modeText(data.mode || brief.mode),
      resultText: resultText(data.result || brief.result),
      cls: resultClass(data.result || brief.result),
      score: data.score || `${data.scoreSelf ?? brief.scoreSelf ?? '?'}-${data.scoreEnemy ?? brief.scoreEnemy ?? '?'}`,
      lengthText: duration(data.durationSec ?? brief.durationSec),
      dateText: dateTime(data.startedAt ?? brief.startedAt),
      myTeam,
      // 全场名次（1 = MVP）；0 表示数据源没给
      myRank: Number(data.rankInMatch) > 0 ? Number(data.rankInMatch) : 0,
      isMvp: data.mvp === true,
      rounds: (data.rounds || []).map(r => ({
        side: String(r.side || '').toLowerCase() === 'def' ? 'def' : 'atk',
        cls: resultClass(r.result)
      })),
      players: await Promise.all(players.map(async p => ({
        ...p,
        agentIcon: await asset(p.agentIcon),
        rankIcon: await asset(p.rankIcon)
      })))
    })
    return true
  }
}

export default ValorantMatches
