/**
 * QQ 扫码「现场版」：出一张码 → 一直守着 → 过期自动换新码 → 扫完落库查战绩。
 *
 * 为什么单独写这个：`test-login.mjs` 是「出码就完事」的一次性脚本，
 * 而 QQ 的码只有 ~120 秒，人在聊天窗口和终端之间来回切的时候经常就过期了。
 * 这里把「换码」做成后台能力，过期了立刻再写一张新 PNG，不用重开浏览器、
 * 也不用重新跑一遍 8 秒的出码流程。
 *
 * 用法（在插件目录）：
 *   LOGIN_TTL=600 LOGIN_DEBUG=1 node tools/qq-live.mjs
 *
 *   ⚠️ LOGIN_TTL 一定要放大：默认 180 秒是**会话**的生命周期，而 QQ 的码
 *      自己只有 ~120 秒。TTL 太短会出现「码还没用上，会话先被判过期」，
 *      那样即便后面换到新码也没法 commit 落库了。
 *
 * 输出：
 *   /tmp/qq-live-1.png   第一张
 *   /tmp/qq-live-2.png   过期后自动换的第 N 张
 *   终端里同步打印每张的路径、页面文字、轮询状态
 */
import { writeFileSync } from 'node:fs'
import { createLoginManager } from '../bridge/login/index.js'

const WAIT_MS = (Number(process.env.WAIT_SECONDS) || 600) * 1000
const USER = process.env.LOGIN_USER || 'qqcli'

const manager = createLoginManager()
console.log('适配器：', manager.list().join(' / '))

const t0 = Date.now()
let started
try {
  started = await manager.start('qq', USER)
} catch (error) {
  console.error(`❌ 出码失败 [${error.code || 'ERR'}]：${error.message}`)
  process.exit(1)
}

const session = manager.sessions.get(started.sessionId)
const state = session?.state

let n = 0
/** 这张码是什么时候出的 —— 用它算年龄，不依赖页面文案 */
let qrAt = Date.now()
function saveQR (uri, note = '') {
  const s = String(uri)
  const ext = /^data:image\/(\w+)/.exec(s)?.[1] || 'png'
  const file = `/tmp/qq-live-${++n}.${ext === 'jpeg' ? 'jpg' : ext}`
  writeFileSync(file, Buffer.from(s.slice(s.indexOf(',') + 1), 'base64'))
  qrAt = Date.now()
  const kb = Math.round(s.length * 0.75 / 1024)
  const hhmmss = new Date(qrAt).toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`✅ 第 ${n} 张码：${file}（${kb} KB，${hhmmss}）${note}`)
  console.log(`   READY ${file}`)
  return file
}

console.log(`出码耗时 ${Date.now() - t0}ms`)
saveQR(started.qr)
const txt0 = await state?.pageText?.().catch?.(() => '') ?? ''
if (txt0) console.log('   页面文字：', String(txt0).slice(0, 120))

const deadline = Date.now() + WAIT_MS
let lastStatus = ''
/** 一张码活多久就主动换 —— QQ 侧真有效期 ~120s，留 20s 余量 */
const QR_LIFE = (Number(process.env.QR_LIFE) || 100) * 1000
let confirmed = null

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 2000))

  let view
  try {
    view = await manager.poll(started.sessionId)
  } catch (error) {
    console.log('   poll 出错：', error.message)
    continue
  }

  if (view.status !== lastStatus) {
    lastStatus = view.status
    console.log(`   [${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${view.status} — ${view.message}`)
  }

  if (['confirmed', 'expired', 'blocked', 'cancelled'].includes(view.status)) {
    if (view.status === 'confirmed') confirmed = view
    break
  }

  /**
   * 主动续码：不看页面文案，按时间换。
   *
   * 实测有些版式的授权页过期了也不改文案，等它自己喊「已失效」等于白等，
   * 而二维码在 QQ 侧就 ~120 秒。所以只要这张码活了超过 QR_LIFE 秒就换一张。
   */
  if (view.status === 'waiting' && Date.now() - qrAt > QR_LIFE) {
    try {
      const fresh = await state.refreshQR({ force: true })
      saveQR(fresh, `（到期主动换，上一张活了 ${Math.round((Date.now() - qrAt) / 1000)}s）`)
    } catch (error) {
      console.log('   换码失败：', error.message)
      qrAt = Date.now()
    }
  }
}

if (confirmed) {
  console.log('🎉 登录成功')
  console.log('   profile:', JSON.stringify(confirmed.profile))
  const credential = manager.sessions.get(started.sessionId)?.credential
  if (!credential?.cookie) {
    console.log('⚠️  适配器没给出 cookie，没法落库')
  } else {
    const { mateappProvider } = await import('../bridge/providers/mateapp.js')
    try {
      const saved = await mateappProvider.saveLogin({ user: USER, credential })
      console.log(`💾 已落库：bridge/accounts/${USER}.json`)
      console.log('   role:', JSON.stringify(saved?.role || {}))
      const account = await mateappProvider.getAccount({ query: '', user: USER })
      console.log(`📋 账号：${account.name}（${account.puuid}）`)
      const result = await mateappProvider.getMatches({ account: '', count: 3, user: USER })
      for (const m of result?.list || []) {
        console.log(`   · ${m.mapName} | ${m.agentName} | ${m.kills}/${m.deaths}/${m.assists} | ACS ${m.acs}`)
      }
    } catch (error) {
      console.log(`❌ 落库/查询失败 [${error.code || 'ERR'}]：${error.message}`)
    }
  }
} else {
  console.log('没等到 confirmed，退出。')
}

manager.cancel(started.sessionId)
process.exit(confirmed ? 0 : 2)
