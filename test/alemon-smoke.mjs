/**
 * alemonjs 适配层的**离线冒烟测试**（不需要真的跑 alemonjs，也不需要联网）。
 *
 * 跑：node test/alemon-smoke.mjs
 *
 * 验证四件事：
 * 1. 垫片装上后，`apps/` 里的 `extends plugin` 能正常实例化（否则适配根本无从谈起）；
 * 2. `apps/` 扫出来的指令表和云崽看到的是同一份；
 * 3. `alemon.js` 那条总入口正则真的能兜住**每一条**指令（漏一条就废一条功能）；
 * 4. 按 priority 分发的结果符合预期。
 *
 * ⚠️ 这里只测「匹配到哪条 rule」，**不执行业务方法** —— 执行要连网关、读配置，
 *    那是真机集成测试的事。
 */
import { installShim } from '../adapter/shim.js'
import { loadAppClasses } from '../adapter/apps.js'

// 1) 装垫片：模拟非云崽环境里没有 plugin 全局的情况
installShim()

let failed = 0
const ok = (cond, label) => {
  if (cond) {
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
  }
}

console.log('\n[1] 垫片')
ok(typeof globalThis.plugin === 'function', 'globalThis.plugin 已就位')
ok(typeof globalThis.logger?.info === 'function', 'globalThis.logger.info 可用')
ok(typeof globalThis.logger?.mark === 'function', 'globalThis.logger.mark 已被补齐（不会炸）')

console.log('\n[2] 扫描 apps/')
const classes = await loadAppClasses(msg => console.log(`  ⚠️  ${msg}`))
ok(classes.length >= 8, `扫到 ${classes.length} 个指令模块（期望 ≥8）`)

// 构建和 dispatch.js 完全一致的指令表
const table = []
for (const { name, Ctor } of classes) {
  const inst = new Ctor()
  for (const rule of inst.rule || []) {
    table.push({
      owner: name,
      fnc: rule.fnc,
      reg: rule.reg instanceof RegExp ? rule.reg : new RegExp(String(rule.reg)),
      priority: inst.priority ?? 1000,
      permission: rule.permission
    })
  }
}
table.sort((a, b) => a.priority - b.priority)
ok(table.length >= 20, `共 ${table.length} 条 rule（期望 ≥20）`)
ok(table.every(t => typeof t.owner === 'string' && t.reg), '每条 rule 都能解析成正则')

// 3) alemon.js 里的总入口正则（要和那边保持一致）
const ENTRY = /^\s*(?:[#＃!！]?\s*(?:瓦|无畏契约).|curl\s+['"]?https:\/\/app\.mval\.qq\.com)/

console.log('\n[3] 总入口正则覆盖')

/** 每条指令给一个真实用户会发的样例 */
const SAMPLES = [
  ['#瓦面板', 'profile'],
  ['瓦面板', 'profile'],
  ['#瓦主页 张三#1234', 'profile'],
  ['#瓦战绩', 'matches'],
  ['#瓦战绩 20', 'matches'],
  ['#瓦战绩 隔壁老王', 'matches'],
  ['#瓦详情1', 'detail'],
  ['#瓦对局详情 3', 'detail'],
  ['#瓦枪械', 'weapons'],
  ['#瓦武器熟练度', 'weapons'],
  ['#瓦绑定 苦橘甘来#CN1', 'bind'],
  ['#瓦账号', 'list'],
  ['#瓦可选账号', 'bound'],
  ['#瓦号源', 'bound'],
  ['#瓦切换 2', 'switch'],
  ['#瓦删除 1', 'remove'],
  ['#瓦同场', 'list'],
  ['#瓦隐藏战绩 某某', 'hide'],
  ['#瓦状态', 'status'],
  ['#瓦数据源状态', 'status'],
  ['#瓦清缓存', 'clear'],
  ['#瓦强制清缓存', 'clear'],
  ['#瓦登录', 'status'],
  ['#瓦登录状态', 'status'],
  ['#瓦退出登录', 'logout'],
  ['#瓦导入 curl xxx', 'importCred'],
  ['#瓦扫码登录', 'scanLogin'],
  ['#瓦帮助', 'help'],
  ['#瓦插件帮助', 'help'],
  ['#瓦更新', 'update'],
  ['#瓦强制更新', 'update'],
  ['#瓦更新日志', 'update_log'],
  ['#无畏契约更新', 'update'],
  ['#无畏契约插件更新日志', 'update_log'],
  ["curl 'https://app.mval.qq.com/go/codev/career/score/update?x=1'", 'importCred']
]

for (const [sample, expectFnc] of SAMPLES) {
  const hit = table.find(t => t.reg.test(sample))
  const covered = ENTRY.test(sample)
  const label = `${sample} → ${hit ? `${hit.owner}.${hit.fnc}` : '未命中'}${covered ? '' : '（总入口漏了！）'}`
  ok(hit && covered && hit.fnc === expectFnc, label)
}

console.log('\n[4] 无关消息不该进总入口')
for (const text of ['今天天气不错', '#你好', '/help', '瓦', '#无畏']) {
  ok(!ENTRY.test(text), `「${text}」不会误触发`)
}

console.log('\n[5] 权限与优先级')
const clear = table.find(t => t.fnc === 'clear')
ok(clear?.permission === 'master', '#瓦清缓存 标了 master 权限')
const update = table.find(t => t.owner === 'update')
ok((update?.priority ?? 0) > 1000, `#瓦更新 的 priority=${update?.priority}（兜底，应大于 1000）`)
ok(table[table.length - 1].owner === 'update' || table[table.length - 1].priority >= 5010, '分发表末尾是更新指令')

console.log(failed ? `\n❌ ${failed} 项未通过\n` : '\n✅ 全部通过\n')
process.exit(failed ? 1 : 0)
