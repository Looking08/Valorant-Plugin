import fs from 'node:fs'
import { PluginData } from '#components'

const dataDir = PluginData
const dataFile = `${dataDir}/UserData.json`

/**
 * 用户↔游戏账号绑定表。
 *
 * 结构：
 * ```json
 * {
 *   "123456": {                    // QQ 号
 *     "accounts": [
 *       { "id": "xxx#1234", "name": "xxx", "tag": "1234", "region": "ap", "note": "" }
 *     ],
 *     "current": 0
 *   }
 * }
 * ```
 *
 * ⚠️ 每次写入都走「读 → 改 → 全量写」。文件不大（几十 KB），换来的是
 *    没有任何并发写坏文件的可能，也不用在多进程间维护内存状态。
 */
function ensureStore () {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify({}, null, 2), 'utf8')
}

function readStore () {
  ensureStore()
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8') || '{}')
  } catch {
    // 文件写坏了不能让用户彻底查不了 —— 备份一份让用户自己捞数据
    try {
      fs.copyFileSync(dataFile, `${dataFile}.broken.${Date.now()}`)
    } catch {}
    return {}
  }
}

function writeStore (store) {
  ensureStore()
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), 'utf8')
}

/** 取用户信息，不存在就建一个空壳 */
export function getUserInfo (userId) {
  const store = readStore()
  const key = String(userId)
  if (!store[key]) {
    store[key] = { accounts: [], current: 0 }
    writeStore(store)
  }
  return { store, info: store[key] }
}

/** 更新用户信息 */
export function saveUserInfo (userId, updater) {
  const store = readStore()
  const key = String(userId)
  const current = store[key] || { accounts: [], current: 0 }
  store[key] = updater(current) || current
  writeStore(store)
  return store[key]
}

/**
 * 取当前使用的账号
 * @returns {{ id: string, name: string, tag: string, region: string }|null}
 */
export function getCurrentAccount (userId) {
  const { info } = getUserInfo(userId)
  if (!info.accounts?.length) return null
  const idx = Number.isInteger(info.current) ? info.current : 0
  return info.accounts[idx] || info.accounts[0] || null
}

/** 绑定列表格式化成给消息看的文本 */
export function formatAccountList (info) {
  if (!info.accounts?.length) return '暂无绑定账号'
  return info.accounts
    .map((a, i) => `${i === info.current ? '✅' : '☑️'} ${i + 1}. ${a.id}${a.region ? `（${a.region}）` : ''}${a.note ? ` ${a.note}` : ''}`)
    .join('\n')
}

/** 把 用户#标签 拆成 name / tag */
export function parseRiotId (raw) {
  const text = String(raw || '').trim().replace(/^#/, '')
  const m = text.match(/^(.+?)\s*[#＃]\s*(\w[\w-]*)$/)
  if (!m) return null
  return { name: m[1].trim(), tag: m[2].trim(), id: `${m[1].trim()}#${m[2].trim()}` }
}
