/**
 * 网关登录链路自测（在容器里跑）：模拟插件 apps/login.js 的四步。
 *   /v1/login/start  → 出码
 *   /v1/login/poll   → 盯状态
 *   /v1/login/commit → 落库
 *   /v1/matches      → 查战绩
 */
import { writeFileSync } from 'node:fs'

const BASE = process.env.GW || 'http://127.0.0.1:7820'
const TOKEN = process.env.TOKEN || 'change-me'
const USER = process.env.USER_ID || 'cli'
const TYPE = process.env.TYPE || 'wx'

const api = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const json = await res.json()
  if (!json.ok) throw new Error(`${path} → ${json.error?.code || res.status} ${json.error?.message || ''}`)
  return json.data
}

const t0 = Date.now()
const started = await api(`/v1/login/start?type=${TYPE}&user=${encodeURIComponent(USER)}`)
const qr = String(started.qr || '')
const b64 = qr.slice(qr.indexOf(',') + 1)
const file = `/tmp/gw-${TYPE}.jpg`
writeFileSync(file, Buffer.from(b64, 'base64'))
console.log(`✅ 网关出码 ${Date.now() - t0}ms  会话 ${started.sessionId}  有效期 ${started.expireIn}s`)
console.log(`   二维码 → ${file}`)

const deadline = Date.now() + (Number(process.env.WAIT) || started.expireIn) * 1000
let last = null
let said = ''
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 2000))
  try { last = await api(`/v1/login/poll?session=${started.sessionId}`) } catch (e) { console.log('   poll:', e.message); continue }
  if (!last) continue
  if (last.status !== said) {
    said = last.status
    console.log(`   ${new Date().toLocaleTimeString()} → ${last.status}${last.message ? ` (${last.message})` : ''}`)
  }
  if (['confirmed', 'expired', 'blocked', 'cancelled'].includes(last.status)) break
}

if (last?.status !== 'confirmed') {
  console.log(`\n⚠️  没扫成：${last?.status}`)
  process.exit(2)
}

console.log(`\n🎉 确认登录：${last.message}`)
console.log('   profile:', JSON.stringify(last.profile))

const saved = await api(`/v1/login/commit?session=${started.sessionId}`)
console.log('\n💾 落库:', JSON.stringify(saved))

try {
  const account = await api(`/v1/account?user=${encodeURIComponent(USER)}&query=`)
  console.log(`\n📋 账号：${account.name}（${account.puuid}） 等级 ${account.level ?? '?'}`)
  const result = await api(`/v1/matches?user=${encodeURIComponent(USER)}&account=&count=3`)
  const list = result?.list || []
  console.log(`   最近 ${list.length} 场：`)
  for (const m of list) {
    console.log(`   · ${m.mapName || '?'} | ${m.mode || '?'} | ${m.agentName || '?'} | ${m.kills}-${m.deaths}-${m.assists} | ACS ${m.acs ?? '?'}`)
  }
  if (result?.summary) console.log('   汇总:', JSON.stringify(result.summary))
} catch (e) {
  console.log('\n⚠️  查战绩失败：', e.message)
}
