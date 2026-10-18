/**
 * 掌瓦数据源探针。
 *
 * 填完 bridge/mate.json 之后跑它，一次说清三件事：
 *   1. **通不通、错在哪** —— 比起网关再发指令快得多
 *   2. **原始 JSON 长什么样** —— 存到 bridge/.state/mate-probe-<名字>.json，
 *      并打印顶层字段/数组结构，上游改结构时照着这个改 MAPPING
 *   3. **映射后能不能看** —— `--map` 会把 MAPPING 的输出也打一遍，
 *      等于提前看到插件要渲染的数据，不用等出图
 *
 * 用法（在插件根目录，不是云崽根目录）：
 *   node bridge/providers/mateapp-cli.mjs              # 探全部
 *   node bridge/providers/mateapp-cli.mjs profile      # 只探一条
 *   node bridge/providers/mateapp-cli.mjs --map        # 探完再跑一遍映射
 *
 * 单局那几个接口需要 battle_id，探针会先拉一次战绩列表，取第一条自动填进去。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callEndpoint, readConfig, mateappProvider, WEAPON_MAP } from './mateapp.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = path.join(HERE, '..', '.state')

/** 依赖 battle_id 的接口：探之前要先知道「探哪一局」 */
const NEEDS_BATTLE = new Set(['match', 'matchRounds', 'roundOverview'])

const ALL = [
  'profile', 'stat', 'agents', 'maps', 'recent',
  'matches', 'match', 'matchRounds', 'weapons', 'roundOverview'
]

const args = process.argv.slice(2)
const withMap = args.includes('--map')
const picked = args.filter(a => ALL.includes(a))

/** 把 JSON 的形状描述出来：顶层字段 + 数组第一项的字段 */
function describe (value, indent = '  ') {
  if (value === null || value === undefined) return `${indent}(空)`
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}空数组`
    const first = value[0]
    const inner = typeof first === 'object' && first
      ? `${indent}  第一项字段：${Object.keys(first).join(', ')}`
      : `${indent}  第一项：${JSON.stringify(first).slice(0, 80)}`
    return `${indent}数组 ${value.length} 项\n${inner}`
  }
  if (typeof value === 'object') {
    const lines = Object.entries(value).map(([k, v]) => {
      if (Array.isArray(v)) return `${indent}· ${k}: 数组(${v.length})${v.length ? ` 第一项字段 → ${Object.keys(v[0] || {}).join(', ') || String(v[0]).slice(0, 40)}` : ''}`
      if (v && typeof v === 'object') return `${indent}· ${k}: {${Object.keys(v).join(', ')}}`
      return `${indent}· ${k}: ${JSON.stringify(v)}`
    })
    return `${indent}对象\n${lines.join('\n')}`
  }
  return `${indent}${JSON.stringify(value)}`
}

/* ---------------- 先检查配置 ---------------- */

console.log('=== 掌瓦数据源探针 ===\n')

let config
try {
  config = readConfig()
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exit(1)
}

const target = process.env.MATE_CONFIG || 'bridge/mate.json'
const cookie = String(config.login?.cookie || config.login?.headers?.Cookie || config.login?.headers?.cookie || '')

console.log(`配置文件：${target}`)
console.log(`baseUrl ：${config.baseUrl || '（没填！）'}`)
console.log(`角色    ：${config.role?.name || '(没填 name)'} / uid=${config.role?.uid || '(没填)'}`)
console.log(`Cookie  ：${cookie ? `已填（${cookie.length} 字符）` : '（没填！）'}`)
console.log(`scene   ：${config.login?.scene ? `已填（${config.login.scene.length} 字符）` : '（没填！）'}`)
console.log(`sceneDet：${config.login?.sceneDetail ? `已填（${config.login.sceneDetail.length} 字符）` : '空（会退回用 scene）'}`)

const missing = ALL.filter(k => !NEEDS_BATTLE.has(k) && !config.endpoints?.[k]?.path)
if (missing.length) console.log(`\n⚠️ 还没填路径的接口：${missing.join(', ')}`)
if (!cookie) console.log('⚠️ Cookie 没填。掌瓦的接口靠它认人，不填一定 401/403。')

/* ---------------- 逐条探 ---------------- */

const list = picked.length ? picked : ALL.filter(k => config.endpoints?.[k]?.path)

if (!list.length) {
  console.log('\n没有可探的接口，先填 endpoints。')
  process.exit(0)
}

fs.mkdirSync(STATE_DIR, { recursive: true })

let okCount = 0
/** 探到的第一条 battle_id，给单局那几个接口用 */
let battle = null

/** 从战绩列表里挑一局当探针样本 */
async function pickBattle () {
  if (battle) return battle
  try {
    const raw = await callEndpoint('matches', { baton: '' })
    const row = (raw?.battle_list || [])[0]
    if (row) {
      battle = {
        id: String(row.battle_id || row.match_id || ''),
        queueId: String(row.game_mode_id || config.defaults?.queueId || '255'),
        gameMode: String(row.game_submode_id || config.defaults?.gameMode || '101001'),
        label: `${row.content || ''} ${row.kda || ''}`.trim()
      }
      console.log(`\n（探针样本：${battle.id} ${battle.label}）`)
    }
  } catch (error) {
    console.log(`\n（挑样本失败：${error.message}）`)
  }
  return battle
}

for (const name of list) {
  console.log(`\n──────── ${name} ────────`)

  const extra = {}
  if (NEEDS_BATTLE.has(name)) {
    const sample = await pickBattle()
    if (!sample?.id) {
      console.log('✗ 拿不到 battle_id，先让 matches 那一条探通')
      continue
    }
    extra.battleId = sample.id
    extra.queueId = sample.queueId
    extra.gameMode = sample.gameMode
    extra.roundNum = 0
  }

  const started = Date.now()
  try {
    const data = await callEndpoint(name, extra)
    okCount += 1

    const file = path.join(STATE_DIR, `mate-probe-${name}.json`)
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')

    console.log(`✓ 通（${Date.now() - started}ms）`)
    console.log(describe(data))
    console.log(`  原始响应已存：${path.relative(process.cwd(), file)}`)
  } catch (error) {
    console.log(`✗ ${error.code || 'ERROR'}：${error.message}`)
    if (error.code === 'UPSTREAM_AUTH') {
      console.log('  → 登录态问题。重新抓一次包，把新的 Cookie / scene 换进 mate.json。')
    }
    if (error.code === 'NOT_FOUND') {
      console.log('  → 接口说「没有」，可能是 uid 填错、路径不对，或者这个角色真的没数据。')
    }
    if (error.code === 'NOT_CONFIGURED') {
      console.log('  → 配置缺项，先把 mate.json 里对应的字段补上。')
    }
  }
}

console.log(`\n=== 结果：${okCount}/${list.length} 条通 ===`)

/* ---------------- 再跑一遍映射（--map） ---------------- */

if (withMap) {
  console.log('\n\n=== 映射结果（这就是插件要渲染的数据） ===')
  const account = config.role?.uid || ''

  const tasks = [
    ['面板 profile', () => mateappProvider.getProfile({ account })],
    ['战绩 matches', () => mateappProvider.getMatches({ account, count: 5 })],
    ['枪械 weapons', () => mateappProvider.getWeapons({ account })]
  ]
  if (battle?.id) {
    tasks.push(['详情 match', () => mateappProvider.getMatch({ matchId: battle.id, account })])
  }

  for (const [label, run] of tasks) {
    console.log(`\n──────── ${label} ────────`)
    try {
      const out = await run()
      console.log(JSON.stringify(out, null, 2).slice(0, 2600))
      if (JSON.stringify(out).length > 2600) console.log('  …（后面还有，完整内容见上面存的 .state 文件）')
    } catch (error) {
      console.log(`✗ ${error.code || 'ERROR'}：${error.message}`)
    }
  }

  console.log(`\n武器名对照表已内置 ${Object.keys(WEAPON_MAP).length} 把枪。`)
}

if (okCount) {
  console.log('\n下一步：PROVIDER=mateapp node bridge/server.mjs 起网关，然后在群里发 #瓦面板 试。')
}
