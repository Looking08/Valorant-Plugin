/**
 * 数据面板（`#瓦面板` / `#瓦主页`）。
 *
 * 网关返回的是「玩家 + 一批 uuid 和数值」，中文名和图标不归它管：
 * 这里拿 uuid 到 utils/staticData.js 里查一遍（valorant-api + 本地缓存），
 * 补上 `displayName` / 图标路径，再丢给模板。数据源因此只要返 stable id 就行。
 */
import {
  getProfile,
  agentOf,
  mapOf,
  resolveTarget,
  NeedBind,
  UnknownPeer,
  asset,
  assets,
  GatewayError,
  pct01,
  round,
  thousands,
  kd,
  duration,
  winRateLevel,
  regionText,
  display,
  replyImage
} from '#utils'

export class ValorantProfile extends plugin {
  constructor () {
    super({
      name: '瓦插件_数据面板',
      dsc: '无畏契约个人数据面板',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?瓦(面板|主页|主页数据)[\\s\\S]*$', fnc: 'profile' }
      ]
    })
  }

  async profile (e) {
    // 指令正则里尾部允许带参数，这里把它抠出来（也可能是 @ 别人）
    const raw = e.msg.replace(/^#?瓦(面板|主页|主页数据)/, '').trim()

    let account
    try {
      account = (await resolveTarget(e, raw)).account
    } catch (error) {
      if (error instanceof NeedBind || error instanceof UnknownPeer) await e.reply(error.message)
      else throw error
      return true
    }

    let data
    try {
      data = await getProfile(account.id, account.region, e.user_id)
    } catch (error) {
      if (error instanceof GatewayError) await e.reply(error.message)
      else {
        logger.error(`[瓦插件] 面板查询失败：${error.message}`)
        await e.reply('查询失败了，详情看日志。')
      }
      return true
    }

    const cfg = display()
    const acc = data.account || {}
    const stats = data.stats || {}

    // 特工：补名字和肖像
    // `a.portrait` 是给「自带图标的数据源」留的后门 —— 掌瓦这类第三方源的
    // 特工 id 是 3004 这种数字，查不到 valorant-api 的 uuid，图标只能由网关给。
    const rawAgents = (data.agents || []).slice(0, cfg.agentsDefault)
    const agents = await assets(
      await Promise.all(rawAgents.map(async a => {
        const info = await agentOf(a.id)
        return {
          name: a.name || info.displayName || a.id,
          role: info.role?.displayName || '',
          roleIcon: '',
          portrait: a.portrait || info.displayIconSmall || info.displayIcon || '',
          matches: a.matches || 0,
          winRate: a.winRate ?? 0,
          winRateText: pct01(a.winRate),
          // 模板里调 Math 不保险（art-template 对未声明标识符的处理各版本不同），
          // 所有派生数值都在 JS 侧算好再丢给模板
          winRatePercent: Math.min(100, Math.round((a.winRate ?? 0) * 100)),
          winRateLevel: winRateLevel(a.winRate),
          kd: a.kd ?? kd(a.kills || 0, a.deaths || 0),
          acs: round(a.acs, 0),
          playtime: Math.round((a.playtimeSeconds || 0) / 3600)
        }
      })),
      'portrait',
      'portrait'
    )

    // 地图：补名字和列表图
    const maps = await assets(
      await Promise.all((data.maps || []).slice(0, 6).map(async m => {
        const info = await mapOf(m.id)
        return {
          name: m.name || info.displayName || m.id,
          listView: m.listView || info.listViewIcon || info.splash || '',
          matches: m.matches || 0,
          winRateText: pct01(m.winRate),
          winRateLevel: winRateLevel(m.winRate)
        }
      })),
      'listView',
      'listView'
    )

    const rank = data.rank || {}
    const peak = data.peakRank || {}

    const tplData = {
      account: {
        id: acc.id || `${acc.name || '?'}#${acc.tag || '?'}`,
        name: acc.name || '',
        tag: acc.tag || '',
        level: acc.accountLevel ?? acc.level ?? 0,
        region: regionText(acc.region || account.region),
        title: acc.title || '',
        card: await asset(acc.card?.wide || acc.card?.large || acc.card?.small || ''),
        avatar: await asset(acc.card?.small || '')
      },
      rank: {
        name: rank.tierName || '未定级',
        rr: rank.rr ?? 0,
        icon: await asset(rank.icon || ''),
        act: rank.act || ''
      },
      peak: {
        name: peak.tierName || '—',
        icon: await asset(peak.icon || ''),
        act: peak.act || ''
      },
      stats: {
        matches: thousands(stats.matches),
        wins: thousands(stats.wins),
        losses: thousands(stats.losses),
        winRateText: pct01(stats.winRate),
        winRateLevel: winRateLevel(stats.winRate),
        kd: round(stats.kd ?? kd(stats.kills, stats.deaths), 2),
        acs: round(stats.acs, 0),
        adr: round(stats.adr, 0),
        // 有些数据源（掌瓦）不提供 KAST，别把「没有」画成 0%
        kastText: stats.kast ? pct01(stats.kast) : '—',
        headshotText: pct01(stats.headshotRate),
        kills: thousands(stats.kills),
        deaths: thousands(stats.deaths),
        assists: thousands(stats.assists),
        playtime: Math.round(stats.playtimeHours || 0),
        rounds: thousands(stats.roundsPlayed)
      },
      agents,
      maps,
      trend: (data.trend || []).map(t => {
        const value = Number(t.value) || 0
        const given = Number(t.height)
        return {
          label: t.label || '',
          value,
          // 数据源可以自己给 height（px）。掌瓦的 ACS 在 150~500 之间，
          // 直接 value/3 会让柱子全部顶格，所以由网关那边按分布缩放到 20~96。
          height: Number.isFinite(given) && given > 0
            ? Math.max(6, Math.min(100, Math.round(given)))
            : Math.max(6, Math.min(100, Math.round(value / 3)))
        }
      }),
      fetchedAt: data.updatedAt || Date.now()
    }

    await replyImage(e, 'ValorantProfile', 'profile.html', tplData)
    return true
  }
}

export default ValorantProfile
