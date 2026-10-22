/**
 * 扫码登录自测：出码 → 弹出图片 → 你扫 → 打印最终结果。
 *
 * 这是唯一能验证「扫完之后换不换得到凭证」的办法 —— 出码和轮询都能自动测，
 * 但「手机上点确认」这一下必须真人来。
 *
 * 用法：
 *   node tools/test-login.mjs wx                    微信码（纯 HTTP，秒出）
 *   node tools/test-login.mjs wx --save --query     扫完落库 + 立刻查最近 3 场
 *   node tools/test-login.mjs qq                    QQ 码（要浏览器，约 10 秒）
 *   node tools/test-login.mjs qq --http             强制走纯 HTTP 版（对比排障用）
 *
 * `--save` 写到 bridge/accounts/<LOGIN_USER>.json（默认 cli），
 * 和机器人里 `#瓦扫码登录` 落盘的是同一份东西，之后网关/插件都能直接用。
 *
 * 出码后会尽量自动打开图片（macOS 用 open，其它平台打印路径）。
 * 不想自动开就 SET_NO_OPEN=1。
 */
import { writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

const type = (process.argv[2] || 'wx').toLowerCase()
const save = process.argv.includes('--save')
const query = process.argv.includes('--query')

// `--http` 要在 import 之前生效（适配器在 start() 里读它），所以这里动态 import
if (process.argv.includes('--http')) {
  process.env.QQ_MODE = 'http'
  console.log('（已强制 QQ 走纯 HTTP 版，用于对比排障）')
}
const { createLoginManager } = await import('../bridge/login/index.js')
const manager = createLoginManager()

function extOf (dataUri) {
  const m = dataUri.match(/^data:image\/(\w+)/)
  const t = m ? m[1].toLowerCase() : 'png'
  return t === 'jpeg' ? 'jpg' : t
}

async function openFile (file) {
  if (process.env.SET_NO_OPEN === '1') return
  if (process.platform !== 'darwin') {
    console.log(`   请手动打开：${file}`)
    return
  }
  await new Promise((resolve) => {
    execFile('open', [file], (error) => {
      if (error) console.log(`   自动打开失败，请手动打开：${file}`)
      resolve()
    })
  })
}

console.log(`适配器：${manager.list().join(' / ')}`)

const t0 = Date.now()
let started
try {
  started = await manager.start(type, 'test-user')
} catch (error) {
  console.error(`❌ ${type} 出码失败 [${error.code || 'ERR'}]：${error.message}`)
  process.exit(1)
}

const qr = String(started.qr)
const file = `/tmp/login-${type}.${extOf(qr)}`
const base64 = qr.slice(qr.indexOf(',') + 1)
writeFileSync(file, Buffer.from(base64, 'base64'))

console.log(`✅ 出码成功（${Date.now() - t0}ms）  有效期 ${started.expireIn}s`)
console.log(`   二维码：${file}（${Math.round(base64.length * 0.75 / 1024)} KB）`)
await openFile(file)
console.log('\n👉 现在用手机扫码，扫完记得在手机上点「确认」…\n')

// 一直盯到终态（或会话过期）。WAIT_SECONDS 可缩短，只为快速验证出码
const waitSec = Number(process.env.WAIT_SECONDS) || started.expireIn
const deadline = Date.now() + waitSec * 1000
let said = 'waiting'
let last = null

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 2000))
  try {
    last = await manager.poll(started.sessionId)
  } catch (error) {
    console.log(`   poll 出错：${error.message}`)
    continue
  }
  if (!last) continue

  if (last.status === 'scanned' && said !== 'scanned') {
    said = 'scanned'
    console.log('   📱 已扫码，等你在手机上点「确认」…')
    continue
  }
  if (last.status === 'waiting' && said !== 'waiting-logged') {
    said = 'waiting-logged'
    console.log('   ⏳ 等待扫码…')
    continue
  }
  if (['confirmed', 'expired', 'blocked', 'cancelled'].includes(last.status)) break
}

console.log('')
if (last?.status === 'confirmed') {
  console.log('🎉 登录成功')
  console.log('   profile:', JSON.stringify(last.profile))
  console.log(`   message: ${last.message}`)

  /**
   * --save：把凭证落库到 bridge/accounts/<user>.json
   * --query：落库后立刻查一把，证明这份 cookie 真能取数
   *
   * 分开做是因为落库会校验（内部打一次真实请求 + 认角色），
   * 失败时能明确区分「登录成功了」和「凭证能用」是两件事。
   */
  const credential = manager.sessions.get(started.sessionId)?.credential || null

  if (save || query) {
    if (!credential?.cookie) {
      console.log('\n⚠️  适配器没给出 cookie，没法落库')
    } else if (!credential.scene) {
      console.log('\n⚠️  有 cookie 但没 scene（没认出角色）。先去掌瓦 App 进一次「我的 → 战绩」再扫。')
    } else {
      const { mateappProvider } = await import('../bridge/providers/mateapp.js')
      const user = process.env.LOGIN_USER || 'cli'
      try {
        const saved = await mateappProvider.saveLogin({ user, credential })
        console.log(`\n💾 已落库：bridge/accounts/${user}.json`)
        console.log('   role:', JSON.stringify(saved?.role || {}))
        if (query && saved?.saved) {
          const account = await mateappProvider.getAccount({ query: '', user })
          console.log(`\n📋 账号：${account.name}（${account.puuid}）`)
          // ⚠️ 两个坑：account 要传**字符串**（不是 getAccount 返回的对象）；
          //    getMatches 返回的是 { list, summary }，不是数组。
          const result = await mateappProvider.getMatches({ account: '', count: 3, user })
          const list = result?.list || []
          console.log(`   最近 ${list.length} 场：`)
          for (const m of list) {
            console.log(`   · ${m.mapName || '?'} | ${m.mode || '?'} | ${m.agentName || '?'} | `
              + `${m.kills}/${m.deaths}/${m.assists} | ACS ${m.acs} | ${m.score || ''} ${m.result || ''}`)
          }
          if (result?.summary) {
            const s = result.summary
            console.log(`   汇总：${s.wins}胜${s.losses}负，胜率 ${Math.round((s.winRate || 0) * 100)}%，`
              + `平均 ACS ${s.acs}，K/D ${s.kd}`)
          }
          if (!list.length) console.log('   （列表是空的 —— 可能这个号本赛季还没打，或者 scene 指向的不是当前赛季）')
        }
      } catch (error) {
        console.log(`\n❌ 落库/查询失败 [${error.code || 'ERR'}]：${error.message}`)
        if (error.code === 'NOT_CONFIGURED') {
          console.log('   先复制一份基础配置：cp bridge/providers/mateapp.example.json bridge/mate.json')
        }
      }
    }
  } else {
    console.log('\n   想落库并立刻验证取数：加 --save --query 再跑一次')
  }
} else if (last?.status === 'blocked') {
  console.log('⚠️  上游没接住：', last.message)
  if (last.hint) console.log('   提示：', last.hint)
} else {
  console.log(`结果：${last?.status || 'timeout'} —— ${last?.message || '没等到'}`)
  if (last?.hint) console.log('   提示：', last.hint)
}

manager.cancel(started.sessionId)
process.exit(last?.status === 'confirmed' ? 0 : 2)
