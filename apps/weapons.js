/**
 * 枪械熟练度（`#瓦枪械` / `#瓦枪械熟练度`）。
 *
 * 和平精英那条同名功能（marksmanshipSkills.js）是按枪械类型筛选 + 看使用时长/击杀/爆头率，
 * 这里做成同一思路：数据源给「每把枪的击杀、命中部位、伤害」，插件算出
 * **爆头率 / 每发伤害 / 每回合击杀**，再按你选的口径排一遍序。
 *
 * 排序口径：`#瓦枪械 击杀`（默认）/ `爆头` / `伤害` / `命中`
 */
import {
  getWeapons,
  weaponOf,
  resolveAccount,
  NeedBind,
  asset,
  GatewayError,
  pct01,
  round,
  thousands,
  regionText,
  display,
  replyImage
} from '#utils'

/** 排序关键字 → { 取值函数, 说明 } */
const SORTERS = {
  kills: { get: w => w.kills, label: '击杀数' },
  击杀: { get: w => w.kills, label: '击杀数' },
  headshot: { get: w => w.headshotRate, label: '爆头率' },
  爆头: { get: w => w.headshotRate, label: '爆头率' },
  damage: { get: w => w.damage, label: '总伤害' },
  伤害: { get: w => w.damage, label: '总伤害' },
  hit: { get: w => w.hits, label: '命中次数' },
  命中: { get: w => w.hits, label: '命中次数' },
  rounds: { get: w => w.roundsUsed, label: '使用回合' },
  回合: { get: w => w.roundsUsed, label: '使用回合' }
}

/** 武器分类 → 中文 */
const CATEGORY = {
  sidearm: '手枪',
  smg: '冲锋枪',
  rifle: '步枪',
  sniper: '狙击枪',
  heavy: '重武器',
  melee: '近战'
}

/** 命中部位三连用的短数字：1105 → 1.1k，917 → 917（口径统一，别一格里混千分位） */
const shortNum = v => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))

export class ValorantWeapons extends plugin {
  constructor () {
    super({
      name: '瓦插件_枪械熟练度',
      dsc: '无畏契约枪械数据查询',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?瓦(枪械|武器)(熟练度)?[\\s\\S]*$', fnc: 'weapons' }
      ]
    })
  }

  async weapons (e) {
    const raw = e.msg.replace(/^#?瓦(枪械|武器)(熟练度)?/, '').trim()
    const cfg = display()

    // 参数里可能混了排序关键字和账号，先把排序关键字挑出来
    let sortKey = Object.keys(SORTERS).find(k => raw.includes(k)) || 'kills'
    const rest = sortKey === 'kills' ? raw : raw.replace(sortKey, ' ').trim()

    let account
    try {
      account = resolveAccount(e, rest).account
    } catch (error) {
      if (error instanceof NeedBind) await e.reply(error.message)
      else throw error
      return true
    }

    let data
    try {
      data = await getWeapons({
        account: account.id,
        region: account.region,
        count: cfg.weaponsMax,
        user: e.user_id
      })
    } catch (error) {
      if (error instanceof GatewayError) await e.reply(error.message)
      else {
        logger.error(`[瓦插件] 枪械数据查询失败：${error.message}`)
        await e.reply('查询失败了，详情看日志。')
      }
      return true
    }

    const rawList = data.list || []
    if (!rawList.length) {
      await e.reply('没查到枪械数据。可能是数据源不支持这项，或者还没打过足够场次。')
      return true
    }

    // 补齐名字/图标 + 算出派生指标
    const enriched = await Promise.all(rawList.map(async w => {
      const info = await weaponOf(w.weaponId)
      const hits = (w.headshots || 0) + (w.bodyshots || 0) + (w.legshots || 0)
      const categoryKey = String(info.category || '').split('::').pop().toLowerCase()
      return {
        name: w.name || info.displayName || w.weaponId,
        // 数据源自带图标时优先用（掌瓦的图在 gtimg 上，valorant-api 不一定收录新枪）
        icon: w.icon || info.displayIcon || '',
        category: CATEGORY[categoryKey] || w.categoryText || '',
        cost: info.shopData?.cost ?? null,
        kills: w.kills || 0,
        headshots: w.headshots || 0,
        bodyshots: w.bodyshots || 0,
        legshots: w.legshots || 0,
        hits,
        headshotRate: hits ? (w.headshots || 0) / hits : 0,
        damage: w.damage || 0,
        damagePerHit: hits ? (w.damage || 0) / hits : 0,
        roundsUsed: w.roundsUsed || 0,
        killsPerRound: w.roundsUsed ? (w.kills || 0) / w.roundsUsed : 0
      }
    }))

    enriched.sort((a, b) => SORTERS[sortKey].get(b) - SORTERS[sortKey].get(a))
    const list = enriched.slice(0, cfg.weaponsDefault)

    // 进度条宽度按 TOP1 归一化，同样是为了让模板里不出现数值运算
    const maxKills = Math.max(1, list[0]?.kills || 1)
    for (const item of list) {
      item.barWidth = Math.max(2, Math.round((item.kills / maxKills) * 100))
      item.icon = await asset(item.icon)
    }

    const totalKills = enriched.reduce((s, w) => s + w.kills, 0)
    const totalDamage = enriched.reduce((s, w) => s + w.damage, 0)
    const totalHits = enriched.reduce((s, w) => s + w.hits, 0)
    const totalHead = enriched.reduce((s, w) => s + w.headshots, 0)

    const acc = data.account || {}

    await replyImage(e, 'ValorantWeapons', 'weapons.html', {
      account: {
        id: acc.id || account.id,
        region: regionText(acc.region || account.region),
        card: await asset(acc.card?.small || '')
      },
      list: list.map(item => ({
        ...item,
        killsText: thousands(item.kills),
        hitsText: `${shortNum(item.headshots)}/${shortNum(item.bodyshots)}/${shortNum(item.legshots)}`,
        headshotText: pct01(item.headshotRate),
        // 数据源不给总伤害（掌瓦只有击杀/爆头率），显示「—」比显示 0 诚实
        damageText: item.damage ? thousands(item.damage) : '—',
        damagePerHitText: item.damagePerHit ? round(item.damagePerHit, 1) : '—',
        killsPerRoundText: round(item.killsPerRound, 2)
      })),
      sortLabel: SORTERS[sortKey].label,
      summary: {
        totalKills: thousands(totalKills),
        totalDamage: totalDamage ? thousands(totalDamage) : '—',
        headshotText: pct01(totalHits ? totalHead / totalHits : 0),
        kinds: enriched.length,
        best: list[0]?.name || '—'
      },
      season: data.season || ''
    })
    return true
  }
}

export default ValorantWeapons
