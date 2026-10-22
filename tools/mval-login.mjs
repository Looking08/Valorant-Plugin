#!/usr/bin/env node
/**
 * mval-login —— 「已经有 QQ token / 微信 code，但扫码路走不通」时的一条近路。
 *
 * 为什么要这个工具：
 *   掌瓦的扫码登录卡在腾讯侧（ptlogin4.openmobile.qq.com 被 DNS 黑洞到 0.0.1，
 *   详见 docs/掌瓦登录链路逆向.md）。但**换票接口本身是好的** —— 只要手里有一份
 *   合法的 QQ access_token + openid，或者一份掌瓦 appid 签发的微信 code，
 *   一条命令就能换出可直接查战绩的凭证。
 *
 * 用法：
 *   # QQ：从任何能拿到 QQ 互联 token 的地方取 openid / access_token
 *   node tools/mval-login.mjs qq --openid=XXXX --token=YYYY --user=123456 --write
 *
 *   # 微信：code 必须是掌瓦 appid（wxcbb49f1f39656c2a）签发的，且只能用一次
 *   #       用成掌盟的 wx5a4a8ac0fd48303a 一定 40029（微信按 appid 隔离 code）
 *   node tools/mval-login.mjs wx --code=ZZZZ --user=123456 --write
 *
 *   --write 会把凭证落到 bridge/accounts/<user>.json（跟 #瓦导入 同一套格式）
 *
 * 成功时打印：cookie / scene / 角色名 / 段位。失败会把上游 ret 码翻译成人话。
 */
import { exchangeMval as exchangeQQ, fetchRole, buildCookie } from '../bridge/login/qq.js'
import { exchangeWX, buildCookieWX, WX_APPIDS } from '../bridge/login/exchange.js'
import { saveAccount } from '../bridge/creds.mjs'

const argv = process.argv.slice(2)
const kind = (argv[0] || '').toLowerCase()
const opt = {}
for (const a of argv.slice(1)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
  if (m) opt[m[1]] = m[2] === undefined ? '1' : m[2]
}

const user = opt.user || process.env.MVAL_USER || ''
const wantWrite = Boolean(opt.write)

function usage (msg) {
  if (msg) console.error(`\n✗ ${msg}\n`)
  console.log(`用法：
  node tools/mval-login.mjs qq --openid=<openid> --token=<access_token> [--user=<QQ号>] [--write]
  node tools/mval-login.mjs wx --code=<微信code> [--appid=<掌瓦appid>] [--user=<QQ号>] [--write]

说明：
  · qq 的 --token 是 QQ 互联的 access_token（qq_info_type=5 那种）
  · wx 的 --code 必须由掌瓦自己的 appid 签发（${WX_APPIDS.join(' / ')}），自建网站应用的 code 会 40029
  · --write 落盘到 bridge/accounts/<user>.json，等同 #瓦导入 的效果
  · 环境变量可替代参数：MVAL_USER / WX_APPID / MVAL_MCODE / MVAL_DEVICE
`)
  process.exit(1)
}

async function main () {
  if (!kind || !['qq', 'wx'].includes(kind)) usage('第一个参数必须是 qq 或 wx')

  let info
  let cookie

  if (kind === 'qq') {
    const openid = opt.openid || process.env.QQ_OPENID
    const token = opt.token || process.env.QQ_ACCESS_TOKEN
    if (!openid || !token) usage('qq 需要 --openid 和 --token')
    console.log('→ 用 QQ token 换掌瓦凭证 …')
    info = await exchangeQQ(openid, token)
    cookie = buildCookie({
      openid,
      accessToken: token,
      userId: String(info.user_id || ''),
      tid: String(info.wt || '')
    })
  } else {
    const code = opt.code || process.env.WX_CODE
    if (!code) usage('wx 需要 --code')
    const appid = opt.appid || process.env.WX_APPID || WX_APPIDS[0]
    console.log(`→ 用微信 code 换掌瓦凭证（appid=${appid}）…`)
    info = await exchangeWX({ code, appid })
    cookie = buildCookieWX({
      openid: info.openid || '',
      accessToken: info.access_token || '',
      userId: String(info.user_id || ''),
      tid: String(info.wt || ''),
      appid
    })
  }

  console.log(`✓ 换票成功：userId=${info.user_id}`
    + `${info.wt ? '  wt=' + String(info.wt).slice(0, 8) + '…' : ''}`
    + `${info.ctt ? '  ctt=' + String(info.ctt).slice(0, 8) + '…' : ''}`)

  console.log('→ 认角色 / 取 scene …')
  const role = await fetchRole(cookie).catch(err => {
    console.warn(`  ! 认角色失败：${err.message}`)
    return null
  })

  const out = {
    cookie,
    scene: role?.scene || '',
    sceneDetail: role?.scene || '',
    role: {
      uid: role?.uid || '',
      roleId: role?.roleId || '',
      name: role?.name || '',
      zone: role?.gameId || 'codev'
    },
    extra: {
      openid: kind === 'qq' ? (opt.openid || '') : '',
      ct: info.ct || '',
      ctt: info.ctt || ''
    }
  }

  if (role?.name) {
    console.log(`✓ 角色：${role.name}（${role.tierText || '段位未知'}）`)
  } else {
    console.log('! 没认出角色：这个号可能还没在掌瓦里绑过无畏契约手游角色')
  }
  if (!out.scene) {
    console.log('! scene 是空的 —— 没有 scene 无法查战绩，需要先从抓包里补（#瓦导入 会自动带上）')
  }

  console.log('\n凭证：')
  console.log(JSON.stringify(out, null, 2))

  if (wantWrite) {
    if (!user) usage('--write 需要同时给 --user（账号标识，通常就是 QQ 号）')
    if (!out.scene) {
      console.error('\n✗ 没有 scene，不落盘（落一份查不了战绩的凭证没有意义）')
      process.exit(2)
    }
    saveAccount(user, {
      cookie: out.cookie,
      scene: out.scene,
      sceneDetail: out.sceneDetail,
      role: out.role,
      source: 'mval-login'
    })
    console.log(`\n✓ 已写入 bridge/accounts/${user}.json`)
  } else {
    console.log('\n提示：加 --user=<QQ号> --write 可直接落盘，省得再走 #瓦导入')
  }
}

main().catch(err => {
  console.error(`\n✗ 失败（${err.code || 'ERROR'}）：${err.message}`)
  if (err.code === 'UPSTREAM_AUTH') {
    console.error('  换票被掌瓦拒了。常见原因：token/code 过期、已被用过、不是掌瓦 appid 签发的。')
  }
  process.exit(1)
})
