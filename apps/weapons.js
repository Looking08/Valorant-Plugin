/**
 * 枪械熟练度（`#瓦枪械` / `#瓦枪械熟练度`）。
 *
 * 掌瓦的 `performance/gun` 只给四个数：**击杀 / 精准击败率（爆头率）/ 每回合击杀 / 最远击败**。
 * 这里就只展示这四个（外加图标、分类、价格）。
 *
 * 早先的版本想凑成「爆头/身体/腿」+「总伤害」+「使用回合」，于是把击杀当命中数拆、
 * 把 damage 写死 0、用 kills ÷ kill_round 反推回合 —— 那三列全是编出来的，
 * 低击杀时还会 `round(1 × 16.7%) = 0` 把爆头率算成 0%。现在一律以「上游给什么就显示什么」
 * 为准，缺的一列都不画。
 *
 * 排序口径：`#瓦枪械 击杀`（默认）/ `爆头` / `每回合` / `最远`
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
  credentialUser,
  queryAccount,
  replyImage
} from '#utils'

/**
 * 排序口径。
 *
 * `keys` 里挑「在指令里出现、且最长」的那个来定口径 —— 否则 `每回合击杀`
 * 会被 `击杀` 先命中，用户以为换了口径其实没换（老版本就是这个毛病）。
 */
const SORTERS = [
  { keys: ['kills', 'kill', '击杀'], get: w => w.kills, label: '击杀数' },
  { keys: ['headshot', 'hs', '爆头'], get: w => w.headRate, label: '爆头率' },
  { keys: ['perround', '每回合', '回合击杀'], get: w => w.killsPerRound, label: '每回合击杀' },
  { keys: ['farthest', 'far', '最远', '距离'], get: w => w.farthest, label: '最远击杀' }
]

const DEFAULT_SORT = SORTERS[0]

/** 已经删掉的口径 —— 用户按老习惯发过来时给句解释，别默默当账号名去解析 */
const DROPPED = ['伤害', '命中']

/** 武器分类 → 中文 */
const CATEGORY = {
  sidearm: '手枪',
  smg: '冲锋枪',
  shotgun: '霰弹枪',
  rifle: '步枪',
  sniper: '狙击枪',
  heavy: '重武器',
  melee: '近战'
}

/** 挑排序口径：命中的关键字越长越优先 */
function pickSort (raw) {
  let best = null
  for (const item of SORTERS) {
    for (const key of item.keys) {
      if (!raw.includes(key)) continue
      if (!best || key.length > best.key.length) best = { item, key }
    }
  }
  return best || { item: DEFAULT_SORT, key: '' }
}

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
    const sort = pickSort(raw)
    if (!sort.key) {
      const dropped = DROPPED.find(k => raw.includes(k))
      if (dropped) {
        await e.reply([
          `掌上无畏契约不提供「${dropped}」这项数据，算了也是错的。`,
          '',
          '能排的口径：击杀 / 爆头 / 每回合 / 最远',
          '例：#瓦枪械 每回合'
        ].join('\n'))
        return true
      }
    }
    const rest = sort.key ? raw.replace(sort.key, ' ').trim() : raw

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
        account: queryAccount(account),
        region: account.region,
        count: cfg.weaponsMax,
        // 按掌瓦号绑定的账号，取数要落到登记人那份登录态上
        user: credentialUser(account, e.user_id)
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

    // 补齐名字/图标/分类，顺便把各数据源的字段归一（mateapp / demo 形状不一样）
    const enriched = await Promise.all(rawList.map(async w => {
      const info = await weaponOf(w.weaponId)
      const categoryKey = String(info.category || '').split('::').pop().toLowerCase()
      const kills = w.kills || 0
      // 上游直接给爆头率就用它（掌瓦的 kill_head）；只有给命中部位的数据源才反算
      const headRate = w.headRate != null
        ? w.headRate
        : (w.hits ? (w.headshots || 0) / w.hits : 0)

      return {
        name: w.name || info.displayName || w.weaponId,
        // 数据源自带图标时优先用（掌瓦的图在 gtimg 上，valorant-api 不一定收录新枪）
        icon: w.icon || info.displayIcon || '',
        category: CATEGORY[categoryKey] || w.categoryText || '',
        cost: info.shopData?.cost ?? null,
        kills,
        headRate,
        killsPerRound: w.killsPerRound != null
          ? w.killsPerRound
          : (w.roundsUsed ? kills / w.roundsUsed : 0),
        farthest: w.farthest != null ? w.farthest : null
      }
    }))

    enriched.sort((a, b) => (sort.item.get(b) || 0) - (sort.item.get(a) || 0))
    const list = enriched.slice(0, cfg.weaponsDefault)

    // 进度条一律按「全部枪里的最高击杀」归一化 —— 换成按爆头排序时，
    // 第一名的击杀可能只有个位数，按它归一化会让所有条都爆表（老版本就是这样）。
    const maxKills = Math.max(1, ...enriched.map(w => w.kills))
    for (const item of list) {
      item.barWidth = Math.max(2, Math.round((item.kills / maxKills) * 100))
      item.icon = await asset(item.icon)
    }

    const totalKills = enriched.reduce((s, w) => s + w.kills, 0)
    // 综合爆头率按击杀加权：跟掌瓦面板「精准击败」同一个分母口径
    const weighted = enriched.reduce((s, w) => s + w.kills * w.headRate, 0)
    const maxFarthest = enriched.reduce((m, w) => ((w.farthest || 0) > m ? w.farthest : m), 0)

    const acc = data.account || {}

    await replyImage(e, 'ValorantWeapons', 'weapons.html', {
      account: {
        id: acc.id || account.id,
        name: acc.name || '',
        region: regionText(acc.region || account.region),
        card: await asset(acc.card?.small || '')
      },
      list: list.map(item => ({
        ...item,
        killsText: thousands(item.kills),
        headRateText: pct01(item.headRate),
        killsPerRoundText: round(item.killsPerRound, 2),
        farthestText: item.farthest ? `${round(item.farthest, 1)}m` : '—'
      })),
      sortLabel: sort.item.label,
      summary: {
        kinds: enriched.length,
        totalKills: thousands(totalKills),
        headRateText: pct01(totalKills ? weighted / totalKills : 0),
        farthestText: maxFarthest ? `${round(maxFarthest, 1)}m` : '—',
        best: list[0]?.name || '—'
      },
      season: data.season || '',
      // 赛季号没取到 = 这里是生涯数据，得说明白，否则又变成「面板和枪械对不上」
      seasonNote: data.seasonResolved === false ? '本赛季号没取到，上面是生涯数据' : ''
    })
    return true
  }
}

export default ValorantWeapons
