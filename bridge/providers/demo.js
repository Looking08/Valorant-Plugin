/**
 * 示例数据源 —— 离线造数据。
 *
 * ⚠️ 这里的数字**不是真实战绩**，只是为了让整套链路（插件 → 网关 → 出图）
 *    零配置先跑起来：你能先看 UT 样子、调模板，不必先折腾抓包和凭证。
 *    真要用，把 PROVIDER 换成你自己的 provider（见 ./README.md）。
 *
 * 为什么要用「确定性随机」：同一个账号每次查出来的数据必须一致，
 *    否则 `#瓦战绩` 列表里的 ACS 和 `#瓦战绩详情` 里对不上 —— 看着像 bug，
 *    其实是随机种子每次都变。这里按 `account + index` 做种子，稳定复现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 扫码凭证落到 bridge/.state/（已 gitignore），方便肉眼确认登录真的走通了 */
const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.state')

/* ---------------- 静态素材（uuid 与图标来自 valorant-api.com 的真实资源） ---------------- */

const AGENTS = [
  { id: 'add6443a-41bd-e414-f6ad-e58d267f4e95', name: '捷风' },
  { id: '569fdd95-4d10-43ab-ca70-79becc718b46', name: '贤者' },
  { id: 'f94c3b30-42be-e959-889c-5aa313dba261', name: '雷兹' },
  { id: '320b2a48-4d9b-a075-30f1-1f93a9b638fa', name: '猎枭' },
  { id: '1e58de9c-4950-5125-93e9-a0aee9f98746', name: '奇乐' },
  { id: '22697a3d-45bf-8dd7-4fec-84a9e28c69d7', name: '尚勃勒' },
  { id: 'dade69b4-4f5a-8528-247b-219e5a1facd6', name: '黑梦' },
  { id: '7f94d92c-4234-0a36-9646-3a87eb8b5c89', name: '夜露' },
  { id: '5f8d3a7f-467b-97f3-062c-13acf203c006', name: '铁臂' },
  { id: 'cc8b64c8-4b25-4ff9-6e7f-37b4da43d235', name: '钢锁' },
  { id: 'b444168c-4e35-8076-db47-ef9bf368f384', name: '钛狐' }
]

const MAPS = [
  { id: '7eaecc1b-4337-bbf6-6ab9-04b8f06b3319', name: '亚海悬城' },
  { id: 'd960549e-485c-e861-8d71-aa9d1aed12a2', name: '霓虹町' },
  { id: 'b529448b-4d60-346e-e89e-00a4c527a405', name: '裂变峡谷' },
  { id: '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba', name: '源工重镇' },
  { id: '2fe4ed3a-450a-948b-6d6b-e89a78e680a9', name: '莲华古城' },
  { id: '224b0a95-48b9-f703-1bd8-67aca101a61f', name: '幽邃地窟' }
]

const WEAPONS = [
  { id: 'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a', name: '幻影' },
  { id: '9c82e19d-4575-0200-1a81-3eacf00cf872', name: '狂徒' },
  { id: 'ae3de142-4d85-2547-dd26-4e90bed35cf7', name: '獠犬' },
  { id: '1baa85b4-4c70-1284-64bb-6481dfc3bb4e', name: '鬼魅' },
  { id: 'e336c6b8-418d-9340-d77f-7a9e4cfe0702', name: '正义' },
  { id: '55d8a0f4-4274-ca67-fe2c-06ab45efdf58', name: '战神' }
]

const MODES = ['competitive', 'competitive', 'competitive', 'unrated', 'swiftplay', 'deathmatch']

const TIERS = [
  { tier: 18, tierName: '钻石一' },
  { tier: 19, tierName: '钻石二' },
  { tier: 20, tierName: '钻石三' },
  { tier: 21, tierName: '超凡一' },
  { tier: 22, tierName: '超凡二' },
  { tier: 23, tierName: '超凡三' },
  { tier: 24, tierName: '神话一' }
]

const tierIcon = tier =>
  `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${tier}/largeicon.png`

const agentPortrait = id => `https://media.valorant-api.com/agents/${id}/displayicon.png`

/* ---------------- 确定性随机 ---------------- */

function hashSeed (str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32：小而够用的确定性 PRNG */
function rng (seedStr) {
  let a = hashSeed(seedStr)
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)]
const between = (rand, min, max) => Math.floor(rand() * (max - min + 1)) + min
const round1 = v => Math.round(v * 10) / 10
const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/* ---------------- 账号解析 ---------------- */

function parseAccount (account) {
  const text = String(account || '').trim()
  const m = text.match(/^(.+?)\s*[#＃]\s*(\w[\w-]*)$/)
  if (m) return { name: m[1].trim(), tag: m[2].trim(), id: `${m[1].trim()}#${m[2].trim()}`, puuid: '' }
  return { name: text, tag: '', id: text, puuid: '' }
}

function buildPuuid (id) {
  // 纯演示用，形式上长得像 uuid 就够了
  return hashSeed(id).toString(16).padStart(8, '0') + '-demo-4a1b-8c9d-valorant0001'
}

function card (id) {
  return {
    small: agentPortrait(pick(rng(`card:${id}`), AGENTS).id),
    large: '',
    wide: ''
  }
}

/* ---------------- 单局生成（列表 / 详情共用） ---------------- */

function makeMatch (accountId, index) {
  const rand = rng(`match:${accountId}:${index}`)
  const map = pick(rand, MAPS)
  const agent = pick(rand, AGENTS)
  const mode = pick(rand, MODES)

  const selfKills = between(rand, 8, 32)
  const selfDeaths = between(rand, 8, 24)
  const selfAssists = between(rand, 1, 14)
  const scoreSelf = between(rand, 4, 13)
  const scoreEnemy = between(rand, 4, 13)
  const win = scoreSelf > scoreEnemy

  const durationSec = between(rand, 1200, 2600)
  const startedAt = Math.floor((Date.now() - (index * 5400 + between(rand, 60, 3600)) * 1000) / 1000)
  const rounds = scoreSelf + scoreEnemy

  // ⚠️ 回合条必须和比分严格对上：先按比分铺好 win/lose，再确定性打乱。
  //    早先是每回合独立掷骰子，于是出现过「5-12 失败」配 12 个绿点的怪图。
  const outcomes = [
    ...Array(scoreSelf).fill('win'),
    ...Array(scoreEnemy).fill('lose')
  ]
  for (let i = outcomes.length - 1; i > 0; i--) {
    const j = Math.floor(rng(`shuffle:${accountId}:${index}:${i}`)() * (i + 1))
    ;[outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]]
  }
  const half = Math.ceil(rounds / 2)
  const roundList = outcomes.map((result, i) => ({
    side: i < half ? 'atk' : 'def',
    result
  }))

  const names = ['玩家甲', '玩家乙', '玩家丙', '玩家丁', 'Shadow', 'Neko', 'ZeroTwo', 'Kirito', 'Asuna', 'Momo']
  const tags = ['0517', '8888', '1024', '2333', 'CN']
  const usedAgents = new Set([agent.id])
  const players = Array.from({ length: 10 }, (_, i) => {
    const prand = rng(`p:${accountId}:${index}:${i}`)
    let pa = pick(prand, AGENTS)
    // 尽量让十个特工不重复
    if (usedAgents.has(pa.id) && i > 0) {
      pa = AGENTS.find(a => !usedAgents.has(a.id)) || pa
    }
    usedAgents.add(pa.id)

    const tier = TIERS[between(prand, 0, TIERS.length - 1)]
    const kills = i === 0 ? selfKills : between(prand, 4, 30)
    const deaths = i === 0 ? selfDeaths : between(prand, 6, 24)
    const assists = i === 0 ? selfAssists : between(prand, 0, 12)
    const hits = Math.max(1, Math.round(kills * between(prand, 6, 11) / 3))
    const headshots = Math.round(hits * between(prand, 18, 42) / 100)

    return {
      agentId: pa.id,
      agentName: pa.name,
      id: i === 0 ? accountId : `${names[i]}#${tags[i % tags.length]}`,
      name: i === 0 ? parseAccount(accountId).name : names[i],
      tag: i === 0 ? parseAccount(accountId).tag : tags[i % tags.length],
      team: i < 5 ? 'red' : 'blue',
      // 真实 provider 用 is_me 标「哪条是我」，demo 也照着给：模板靠它算敌我
      isSelf: i === 0,
      startTeam: i < 5 ? 'atk' : 'def',
      kills,
      deaths,
      assists,
      kd: round1(kills / Math.max(1, deaths)),
      // ACS 的量级参考：职业选手 200~280，路人 100~200，上限也就 400 出头。
      // 早先按「击杀×45 ÷1.35」算，能怼到 700+，图上看着就假。
      acs: clamp(Math.round(kills * 10 + assists * 4 + between(prand, 20, 90)), 40, 400),
      econ: between(prand, 1800, 4600),
      headshots,
      bodyshots: Math.max(0, hits - headshots - Math.round(hits * 0.04)),
      legshots: Math.round(hits * 0.04),
      headshotRate: round1(headshots / Math.max(1, hits) * 100) / 100,
      firstBloods: between(prand, 0, 6),
      plants: between(prand, 0, 5),
      defuses: between(prand, 0, 4),
      rank: { tierName: tier.tierName, icon: tierIcon(tier.tier) }
    }
  })

  const hits = Math.max(1, Math.round(selfKills * 2.6))
  const headshots = Math.round(hits * between(rand, 20, 45) / 100)

  return {
    matchId: `DEMO-${index}-${hashSeed(`${accountId}:${index}`).toString(16).slice(0, 8).toUpperCase()}`,
    mapId: map.id,
    mapName: map.name,
    mode,
    result: win ? 'win' : 'lose',
    scoreSelf,
    scoreEnemy,
    score: `${scoreSelf}-${scoreEnemy}`,
    durationSec,
    startedAt,
    roundsPlayed: rounds,
    rounds: roundList,
    accountId,
    players,
    // 自己在列表里那条还得有一份独立数据（列表不一定取 (0) 号位）
    self: {
      agentId: agent.id,
      agentName: agent.name,
      kills: selfKills,
      deaths: selfDeaths,
      assists: selfAssists,
      kd: round1(selfKills / Math.max(1, selfDeaths)),
      acs: clamp(Math.round(selfKills * 10 + selfAssists * 4 + between(rand, 20, 90)), 40, 400),
      adr: Math.round(selfKills * between(rand, 12, 20)),
      headshots,
      hits,
      headshotRate: round1(headshots / hits * 100) / 100
    }
  }
}

/* ---------------- provider 实现 ---------------- */

function notFound (message) {
  const error = new Error(message)
  error.code = 'NOT_FOUND'
  return error
}

export const demoProvider = {
  name: 'demo',

  async getAccount ({ query, region }) {
    const acc = parseAccount(query)
    if (!acc.name) throw notFound('请传入 名称#标签')

    return {
      puuid: buildPuuid(acc.id),
      id: acc.id,
      name: acc.name,
      tag: acc.tag,
      region: region || 'ap',
      accountLevel: between(rng(`lv:${acc.id}`), 20, 480),
      title: '示例数据 · 非真实战绩',
      card: card(acc.id)
    }
  },

  async getProfile ({ account, region }) {
    const acc = parseAccount(account)
    if (!acc.name) throw notFound('请传入 名称#标签')

    const rand = rng(`profile:${acc.id}`)
    const matches = between(rand, 180, 640)
    const wins = Math.round(matches * (between(rand, 46, 62) / 100))
    const losses = matches - wins
    const kills = Math.round(matches * between(rand, 14, 26))
    const deaths = Math.round(matches * between(rand, 13, 22))
    const tier = TIERS[between(rand, 0, TIERS.length - 1)]
    const peakIdx = Math.min(TIERS.length - 1, TIERS.indexOf(tier) + 1)
    const peak = TIERS[peakIdx]

    const agentCount = between(rand, 4, 7)
    const agents = AGENTS.slice(0, agentCount).map((a, i) => {
      const arand = rng(`pa:${acc.id}:${a.id}`)
      const am = Math.round(matches / between(arand, 3, 9)) || 1
      return {
        id: a.id,
        matches: am,
        winRate: round1(between(arand, 34, 68) / 100 * 100) / 100,
        kills: am * between(arand, 12, 24),
        deaths: am * between(arand, 12, 20),
        kd: round1(1 + arand() * 0.8),
        acs: between(arand, 180, 320),
        playtimeSeconds: am * between(arand, 1300, 1800)
      }
    }).sort((x, y) => y.matches - x.matches)

    const maps = MAPS.slice(0, between(rand, 4, 6)).map((m, i) => {
      const mrand = rng(`pm:${acc.id}:${m.id}`)
      const mm = Math.round(matches / between(mrand, 3, 8)) || 1
      return { id: m.id, matches: mm, winRate: round1(between(mrand, 32, 70) / 100 * 100) / 100 }
    }).sort((x, y) => y.matches - x.matches)

    return {
      account: {
        puuid: buildPuuid(acc.id),
        id: acc.id,
        name: acc.name,
        tag: acc.tag,
        region: region || 'ap',
        accountLevel: between(rand, 20, 480),
        title: '示例数据 · 非真实战绩',
        card: card(acc.id)
      },
      rank: {
        tier: tier.tier,
        tierName: tier.tierName,
        rr: between(rand, 5, 92),
        icon: tierIcon(tier.tier),
        act: '第 9 幕 · 第 3 章'
      },
      peakRank: {
        tier: peak.tier,
        tierName: peak.tierName,
        icon: tierIcon(peak.tier),
        act: '第 9 幕 · 第 2 章'
      },
      stats: {
        matches,
        wins,
        losses,
        winRate: round1(wins / matches * 100) / 100,
        kills,
        deaths,
        assists: Math.round(matches * between(rand, 3, 9)),
        kd: round1(kills / Math.max(1, deaths) * 100) / 100,
        acs: between(rand, 190, 300),
        adr: between(rand, 120, 190),
        kast: round1(between(rand, 66, 82) / 100 * 100) / 100,
        headshotRate: round1(between(rand, 18, 38) / 100 * 100) / 100,
        playtimeHours: Math.round(matches * 0.45),
        roundsPlayed: Math.round(matches * 21)
      },
      agents,
      maps,
      trend: Array.from({ length: 10 }, (_, i) => ({
        label: `#${10 - i}`,
        value: between(rng(`t:${acc.id}:${i}`), 120, 380)
      })).reverse(),
      updatedAt: Date.now()
    }
  },

  async getMatches ({ account, region, count, mode, map }) {
    const acc = parseAccount(account)
    if (!acc.name) throw notFound('请传入 名称#标签')

    const take = Math.min(Math.max(Number(count) || 10, 1), 50)
    const list = []

    for (let i = 0; i < take; i++) {
      const match = makeMatch(acc.id, i)
      const self = match.self
      list.push({
        matchId: match.matchId,
        mapId: match.mapId,
        mapName: match.mapName,
        mode: match.mode,
        result: match.result,
        scoreSelf: match.scoreSelf,
        scoreEnemy: match.scoreEnemy,
        score: match.score,
        agentId: self.agentId,
        agentName: self.agentName,
        kills: self.kills,
        deaths: self.deaths,
        assists: self.assists,
        kd: self.kd,
        acs: self.acs,
        adr: self.adr,
        headshotRate: self.headshotRate,
        roundsPlayed: match.roundsPlayed,
        durationSec: match.durationSec,
        startedAt: match.startedAt,
        accountId: acc.id,
        // 名次按十个人的 ACS 真算（不是硬编码）：demo 也要自洽，
        // 否则「MVP」标在 ACS 只有 120 的人身上，一眼就是假的
        rankInMatch: match.players.filter(p => p.acs > match.players[0].acs).length + 1,
        mvp: match.players.every(p => p.acs <= match.players[0].acs)
      })
    }

    const filtered = list
      .filter(m => !mode || m.mode === mode)
      .filter(m => !map || m.mapId === map || m.mapName === map)

    const wins = filtered.filter(m => m.result === 'win').length
    return {
      account: {
        id: acc.id,
        name: acc.name,
        tag: acc.tag,
        region: region || 'ap',
        card: card(acc.id)
      },
      list: filtered,
      summary: {
        matches: filtered.length,
        wins,
        losses: filtered.length - wins,
        winRate: filtered.length ? round1(wins / filtered.length * 100) / 100 : 0,
        acs: Math.round(filtered.reduce((s, m) => s + m.acs, 0) / Math.max(1, filtered.length)),
        kd: round1(filtered.reduce((s, m) => s + m.kd, 0) / Math.max(1, filtered.length) * 100) / 100
      }
    }
  },

  async getMatch ({ matchId, account }) {
    // 从 matchId 反解出索引，保证详情和列表对得上
    const index = Number(String(matchId).match(/^DEMO-(\d+)-/)?.[1] ?? NaN)
    const owner = account || '示例玩家#8888'
    if (Number.isNaN(index)) throw notFound(`找不到对局 ${matchId}`)

    const match = makeMatch(parseAccount(owner).id, index)
    return {
      matchId: match.matchId,
      mapId: match.mapId,
      mapName: match.mapName,
      mode: match.mode,
      result: match.result,
      scoreSelf: match.scoreSelf,
      scoreEnemy: match.scoreEnemy,
      score: match.score,
      durationSec: match.durationSec,
      startedAt: match.startedAt,
      // demo 里「我」固定是第一条（i=0），按玩家表里的队伍和 ACS 算敌我与名次
      myTeam: match.players[0]?.team || 'red',
      rankInMatch: match.players.filter(p => p.acs > match.players[0].acs).length + 1,
      mvp: match.players.every(p => p.acs <= match.players[0].acs),
      rounds: match.rounds,
      players: match.players
    }
  },

  async getWeapons ({ account, region, season }) {
    const acc = parseAccount(account)
    if (!acc.name) throw notFound('请传入 名称#标签')

    const list = WEAPONS.map((w, i) => {
      const wrand = rng(`w:${acc.id}:${w.id}`)
      const kills = between(wrand, 120, 1800) * (WEAPONS.length - i)
      const hits = Math.round(kills * between(wrand, 22, 40) / 10)
      const headshots = Math.round(hits * between(wrand, 22, 48) / 100)
      const legshots = Math.round(hits * 0.04)
      const bodyshots = Math.max(0, hits - headshots - legshots)
      return {
        weaponId: w.id,
        name: w.name,
        kills,
        headshots,
        bodyshots,
        legshots,
        damage: Math.round(kills * between(wrand, 130, 190)),
        // 反着推更靠谱：先给一个合理的「每回合击杀」(0.2~0.55)，再反算使用回合。
        // 早先是 kills/随机数/10，会算出「每回合 89 击杀」这种一眼假的数字。
        roundsUsed: Math.round(kills / (0.2 + wrand() * 0.35))
      }
    }).sort((a, b) => b.kills - a.kills)

    return {
      account: {
        id: acc.id,
        name: acc.name,
        tag: acc.tag,
        region: region || 'ap',
        card: card(acc.id)
      },
      season: season || '全部数据',
      list
    }
  },

  /**
   * 扫码登录成功后的落库动作。
   *
   * demo 里只是把凭证写到 `bridge/.state/demo-login.json`，让你能 `cat` 一眼
   * 确认「确实拿到了东西」。真实 provider 应该在这里拿 cookie/code 去换
   * 业务 token，再写进自己的存储 —— 这是整个扫码流程里**唯一**跟数据源
   * 强耦合的一步，所以它被安排在 provider 侧而不是插件侧。
   */
  async saveLogin ({ type, cookies, profile }) {
    const nickname = profile?.nickname || '扫码用户'
    const uin = String(profile?.uin || Date.now()).slice(-6)
    const account = `${nickname}#${uin}`

    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(
        path.join(STATE_DIR, 'demo-login.json'),
        JSON.stringify({ type, account, cookies, savedAt: new Date().toISOString() }, null, 2),
        'utf8'
      )
    } catch (error) {
      return { saved: false, hint: `凭证落盘失败：${error.message}` }
    }

    return {
      saved: true,
      account,
      hint: 'demo provider 只把凭证写进 bridge/.state/demo-login.json，不会真去查官方战绩'
    }
  }
}

export default demoProvider
