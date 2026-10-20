/**
 * 无头集成测试：在真实的 TRSS-Yunzai 环境里把插件跑一遍。
 *
 * 不启动 QQ 适配器、不发真消息 —— 只做三件事：
 *   1. 用桩顶掉 Yunzai 注入的全局（plugin / logger / segment），import 插件入口
 *   2. 实例化每个 app，喂一个假的 e，看它能不能走完「取数 → enrich → 出图」
 *   3. 把出的图落到 temp/ 里，肉眼验收 UI
 *
 * 用法（**在云崽根目录**执行，cwd 决定模板里 ../../../ 的解析基准）：
 *   node plugins/Valorant-Plugin/test/valtest.mjs
 *   node plugins/Valorant-Plugin/test/valtest.mjs '#瓦面板 张三#1234' '#瓦枪械'
 *
 * 测试扫码这类「指令返回后还会继续回话」的功能，需要给它时间：
 *   node plugins/Valorant-Plugin/test/valtest.mjs --wait=12 '#瓦扫码登录 mock'
 */
import fs from 'node:fs'
import path from 'node:path'

/* ---------------- 桩：Yunzai 注入的全局 ---------------- */

globalThis.logger = {
  info: (...a) => console.log('[info]', ...a),
  mark: (...a) => console.log('[mark]', ...a),
  debug: (...a) => console.log('[debug]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  green: s => s,
  red: s => s,
  yellow: s => s
}

globalThis.plugin = class {
  constructor (cfg) {
    this.name = cfg.name
    this.dsc = cfg.dsc
    this.event = cfg.event
    this.priority = cfg.priority
    this.rule = cfg.rule
    this.e = null
  }

  reply (msg) {
    return this.e?.reply ? this.e.reply(msg) : Promise.resolve()
  }
}

// TRSS 的 lib/puppeteer/puppeteer.js 会把 Buffer 包成 segment.image，
// 这里给个最小实现，顺便把图存下来
globalThis.segment = {
  image (file) {
    return { type: 'image', file, data: { file } }
  }
}

/* ---------------- 跑插件 ---------------- */

const entry = path.resolve('plugins/Valorant-Plugin/index.js')
const mod = await import(`file://${entry}`)
const apps = mod.apps || {}
console.log('\n=== 已注册模块 ===')
console.log(Object.keys(apps).join(', '))

const results = []

for (const [name, Cls] of Object.entries(apps)) {
  if (typeof Cls !== 'function') continue
  const inst = new Cls()
  results.push({ name, rules: (inst.rule || []).map(r => r.reg).join(' | '), priority: inst.priority })
}
console.log('\n=== 指令规则 ===')
for (const r of results) console.log(`${r.name} (p=${r.priority})\n   ${r.rules}`)

/* ---------------- 真实调用一遍 ---------------- */

const cases = process.argv.slice(2).filter(a => !a.startsWith('--'))

/** --wait=N：跑完后等 N 秒再退出，用来观察定时器里的后续回复（扫码功能） */
const waitArg = process.argv.slice(2).find(a => a.startsWith('--wait='))
const waitSeconds = waitArg ? Math.min(Number(waitArg.split('=')[1]) || 0, 300) : 0

const targets = cases.length
  ? cases
  : [
      '#瓦帮助',
      '#瓦面板 Test#1234',
      '#瓦战绩 Test#1234',
      '#瓦战绩详情 2',
      '#瓦枪械 Test#1234',
      '#瓦状态'
    ]

const outDir = path.resolve('temp/valtest')
fs.mkdirSync(outDir, { recursive: true })

const userId = 10001

for (const msg of targets) {
  // 找到能匹配这条指令的 app
  const hit = Object.values(apps)
    .filter(c => typeof c === 'function')
    .map(c => new c())
    .find(inst => (inst.rule || []).some(r => new RegExp(r.reg).test(msg) && r.fnc))

  if (!hit) {
    console.log(`\n[跳过] 没有 app 匹配：${msg}`)
    continue
  }

  const rule = hit.rule.find(r => new RegExp(r.reg).test(msg) && r.fnc)
  // 同一条指令可能回多次（扫码会先出图、再报「已扫码」、再报「已登录」），
  // 文件加序号后缀，别互相覆盖
  let replyCount = 0
  const saveImage = buf => {
    replyCount += 1
    const base = msg.replace(/[#\s]/g, '_')
    const file = path.join(outDir, `${base}${replyCount > 1 ? `_${replyCount}` : ''}.jpg`)
    fs.writeFileSync(file, buf)
    console.log(`  ✅ 出图 ${(buf.length / 1024).toFixed(0)}KB -> ${file}`)
  }

  const e = {
    user_id: userId,
    msg,
    at: '',
    atme: false,
    isGroup: false,
    reply: async content => {
      // 直接回 Buffer（replyImage、二维码都是这么发的）
      if (Buffer.isBuffer(content)) {
        saveImage(content)
      } else if (content?.type === 'image' && Buffer.isBuffer(content.file)) {
        saveImage(content.file)
      } else if (content?.file && Buffer.isBuffer(content.file)) {
        saveImage(content.file)
      } else {
        console.log(`  💬 ${String(content).slice(0, 400).replace(/\n/g, ' ⏎ ')}`)
      }
      return true
    }
  }

  hit.e = e
  console.log(`\n>>> ${msg}`)
  const start = Date.now()
  try {
    await hit[rule.fnc](e)
    console.log(`  ⏱ ${Date.now() - start}ms`)
  } catch (error) {
    console.error(`  ❌ ${error.message}`)
    console.error(error.stack?.split('\n').slice(1, 4).join('\n'))
  }
}

if (waitSeconds > 0) {
  console.log(`\n⏳ 等待 ${waitSeconds}s，观察定时器里的后续回复…`)
  await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000))
}

console.log('\n=== 完 ===')
process.exit(0)
