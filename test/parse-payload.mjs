/**
 * `parsePayload()` 的离线测试 —— 用真实抓包的形状喂它。
 *
 * 为什么要这个文件：导入失败里最常见的不是用户不会抓包，而是**粘贴的形状不对**
 * （cURL、原始 HTTP、纯 body、只给了 cookie……）。这些分支全靠字符串处理，
 * 改一行就可能悄悄坏掉，所以用真实 HAR 拼出各种形状来跑。
 *
 * 用法（**在云崽根目录**执行，或本机起一个假 plugin 桩）：
 *   node plugins/Valorant-Plugin/test/parse-payload.mjs /path/to/抓包.har
 *
 * 不传 HAR 时用内置的假数据（结构照抄真实抓包），只验解析逻辑。
 */
import fs from 'node:fs'

globalThis.plugin = class {
  constructor (cfg) { Object.assign(this, cfg) }
}
globalThis.logger = { info () {}, debug () {}, warn () {}, error () {}, mark () {} }

const { parsePayload } = await import('../apps/login.js')

/** 从 HAR 里捞一条指定路径的请求，拼成 cURL */
function curlFromHar (har, suffix) {
  const entries = har?.log?.entries || []
  const hit = entries.find(e => {
    try {
      return new URL(e.request.url).host === 'app.mval.qq.com' &&
        new URL(e.request.url).pathname.endsWith(suffix)
    } catch {
      return false
    }
  })
  if (!hit) return null

  const cookie = (hit.request.headers || [])
    .find(h => String(h.name).toLowerCase() === 'cookie')
  const body = hit.request.postData?.text || ''
  if (!cookie) return null

  return [
    `curl '${hit.request.url}' \\`,
    `  -H 'accept: application/json' \\`,
    `  -H 'content-type: application/json; charset=utf-8' \\`,
    `  -H 'cookie: ${cookie.value}' \\`,
    `  --data-raw '${body}'`
  ].join('\n')
}

/** 原始 HTTP 文本形态 */
function rawHttpFromCurl (curl) {
  const url = (curl.match(/curl '([^']+)'/) || [])[1] || ''
  const cookie = (curl.match(/-H 'cookie: ([^']+)'/) || [])[1] || ''
  const body = (curl.match(/--data-raw '([^']+)'/) || [])[1] || ''
  const u = new URL(url)
  return [
    `POST ${u.pathname}${u.search} HTTP/1.1`,
    `Host: ${u.host}`,
    'Content-Type: application/json',
    `Cookie: ${cookie}`,
    '',
    body
  ].join('\n')
}

/* ---------------- 准备素材 ---------------- */

const harPath = process.argv[2]
let listScene = 'v3_listFAKE000000000000000000000000000000000000000000000'
let detailScene = 'v3_detailFAKE00000000000000000000000000000000000'
let cookie = 'clientType=9; appid=wxcbb49f1f39656c2a; access_token=FAKE; userId=JA-fake-uid;'

let curls = []

if (harPath && fs.existsSync(harPath)) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'))
  const listCurl = curlFromHar(har, '/career/record/list')
  const roundsCurl = curlFromHar(har, '/career/record/player/rounds')
  curls = [listCurl, roundsCurl].filter(Boolean)

  if (curls.length) {
    cookie = (curls[0].match(/-H 'cookie: ([^']+)'/) || [])[1] || cookie
    listScene = (curls[0].match(/"scene":"([^"]+)"/) || [])[1] || listScene
    if (curls[1]) detailScene = (curls[1].match(/"scene":"([^"]+)"/) || [])[1] || detailScene
  }
  console.log(`素材：来自 ${harPath}，拿到 ${curls.length} 条请求\n`)
} else {
  curls = [
    `curl 'https://app.mval.qq.com/go/codev/career/record/list?source_game_zone=codev' \\\n` +
    `  -H 'cookie: ${cookie}' \\\n` +
    `  --data-raw '{"scene":"${listScene}","baton":"","mode_filter":"","source_game_zone":"codev"}'`,
    `curl 'https://app.mval.qq.com/go/codev/career/record/player/rounds?source_game_zone=codev' \\\n` +
    `  -H 'cookie: ${cookie}' \\\n` +
    `  --data-raw '{"scene":"${detailScene}","battle_id":"123","game_mode":"101001"}'`
  ]
  console.log('素材：内置假数据（没传 HAR）\n')
}

/* ---------------- 各种粘贴形状 ---------------- */

const cases = [
  {
    name: 'cURL：只贴列表那条',
    input: curls[0],
    expect: { cookie: true, scene: listScene }
  },
  {
    name: 'cURL：列表 + 逐回合两条一起贴',
    input: curls.join('\n\n'),
    expect: { cookie: true, scene: listScene, sceneDetail: detailScene }
  },
  {
    name: '原始 HTTP 请求',
    input: rawHttpFromCurl(curls[0]),
    expect: { cookie: true, scene: listScene }
  },
  {
    name: '一行 pipe',
    input: `${cookie}|${listScene}|${detailScene}`,
    expect: { cookie: true, scene: listScene, sceneDetail: detailScene }
  },
  {
    name: '多行 key=value',
    input: `cookie=${cookie}\nscene=${listScene}\nsceneDetail=${detailScene}`,
    expect: { cookie: true, scene: listScene, sceneDetail: detailScene }
  },
  {
    name: '只贴 cookie（应识别但 scene 为空）',
    input: cookie,
    expect: { cookie: true, scene: '' }
  },
  {
    name: '垃圾内容',
    input: '你好 我想查战绩',
    expect: null
  }
]

let pass = 0
for (const item of cases) {
  const got = parsePayload(item.input)
  const ok = item.expect === null
    ? got === null
    : !!got && !!got.cookie === item.expect.cookie &&
      (item.expect.scene === undefined || got.scene === item.expect.scene) &&
      (item.expect.sceneDetail === undefined || got.sceneDetail === item.expect.sceneDetail)

  console.log(`${ok ? '✅' : '❌'} ${item.name}`)
  if (!ok) {
    console.log('   期望:', JSON.stringify(item.expect))
    console.log('   实际:', JSON.stringify(got && {
      cookie: (got.cookie || '').slice(0, 30) + '…',
      scene: got.scene,
      sceneDetail: got.sceneDetail
    }))
  }
  if (ok) pass += 1
}

console.log(`\n${pass}/${cases.length} 通过`)
process.exit(pass === cases.length ? 0 : 1)
