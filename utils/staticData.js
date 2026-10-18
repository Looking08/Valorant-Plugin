/**
 * 静态游戏数据 —— 走 valorant-api.com（免费、无需 key、支持中文）。
 *
 * ## 为什么单独抽一层
 *
 * 网关只管「某个玩家的实时数据」，管不了「幽影这个特工叫什么、图标在哪」。
 * 这类内容**长期不变**，适合落地缓存：第一次请求之后 12 小时内全读本地，
 * 出图不再等网络。
 *
 * ## 关于中文名
 *
 * valorant-api 的 `?language=zh-CN` 返回的就是官译名（捷影、幻影、亚海悬城…）。
 * 若国服/手游译名与它不一致，或你想顺手改掉几个，把映射写进
 * `resources/data/overrides.json` 覆盖即可，不用动插件代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'
import { staticApi } from './config.js'

const CACHE_DIR = path.join(PluginData, 'static')

/** 支持的集合 */
const KINDS = ['agents', 'maps', 'weapons', 'competitivetiers']

/** 用户自定义名称/图标覆盖 `{ agents: { "<uuid>": { displayName: "..." } } }` */
let overrides = null

function loadOverrides () {
  if (overrides) return overrides
  const file = path.join(process.cwd(), 'plugins', 'Valorant-Plugin', 'resources', 'data', 'overrides.json')
  try {
    overrides = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    overrides = {}
  }
  return overrides
}

function cacheFile (kind) {
  return path.join(CACHE_DIR, `${kind}.json`)
}

/** 缓存还在有效期就直接用 */
function readFreshCache (kind, ttlSec) {
  try {
    const file = cacheFile(kind)
    const stat = fs.statSync(file)
    if (Date.now() - stat.mtimeMs > ttlSec * 1000) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 网络请求一次集合数据 */
async function fetchRemote (kind) {
  const cfg = staticApi()
  const query = `?language=${encodeURIComponent(cfg.language)}`
  const target = `${cfg.url}/v1/${kind}${query}`
  const url = cfg.proxy ? `${cfg.proxy}${encodeURIComponent(target)}` : target

  const res = await fetch(url, {
    signal: AbortSignal.timeout(cfg.timeout),
    headers: { 'User-Agent': 'Valorant-Plugin/0.1 (+yunzai)' }
  })
  if (!res.ok) throw new Error(`valorant-api ${kind} HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.data) throw new Error(`valorant-api ${kind} 返回格式异常`)
  return json.data
}

/**
 * 取一个集合（带本地缓存 + 失败降级）
 * @param {'agents'|'maps'|'weapons'|'competitivetiers'} kind
 * @returns {Promise<Array>}
 */
export async function getCollection (kind) {
  if (!KINDS.includes(kind)) throw new Error(`不支持的集合：${kind}`)

  const cfg = staticApi()
  const cached = readFreshCache(kind, cfg.ttl)
  if (cached) return cached

  try {
    const data = await fetchRemote(kind)
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(cacheFile(kind), JSON.stringify(data))
    } catch {}
    return data
  } catch (error) {
    // 拿不到新的就用旧的 —— 静态数据过期几天不影响使用，
    // 总比整个查询挂掉强
    const stale = readFreshCache(kind, Number.MAX_SAFE_INTEGER)
    if (stale) {
      logger.warn(`[瓦插件] ${kind} 拉取失败，使用过期缓存：${error.message}`)
      return stale
    }
    logger.error(`[瓦插件] ${kind} 拉取失败：${error.message}`)
    return []
  }
}

/** 把集合转成 uuid → 条目 的 Map（含用户覆盖） */
async function buildIndex (kind) {
  const raw = await getCollection(kind)
  const ov = loadOverrides()[kind] || {}
  const map = new Map()
  for (const item of raw) {
    if (!item?.uuid) continue
    map.set(item.uuid, { ...item, ...(ov[item.uuid] || {}) })
  }
  return map
}

let indexCache = {}

export async function agents () {
  indexCache.agents = indexCache.agents || buildIndex('agents')
  return indexCache.agents
}

export async function maps () {
  indexCache.maps = indexCache.maps || buildIndex('maps')
  return indexCache.maps
}

export async function weapons () {
  indexCache.weapons = indexCache.weapons || buildIndex('weapons')
  return indexCache.weapons
}

export async function tiers () {
  indexCache.tiers = indexCache.tiers || buildIndex('competitivetiers')
  return indexCache.tiers
}

/** 按 uuid 取详情，拿不到就返回安全的占位对象 */
async function lookup (mapPromise, id) {
  const fallback = { displayName: '', displayIcon: '', displayIconSmall: '' }
  if (!id) return fallback
  try {
    const map = await mapPromise()
    return map.get(String(id)) || fallback
  } catch {
    return fallback
  }
}

export const agentOf = id => lookup(agents, id)
export const mapOf = id => lookup(maps, id)
export const weaponOf = id => lookup(weapons, id)

/** 按名字找条目（支持中文名和英文名，忽略大小写） */
export async function findByName (kind, name) {
  const keyword = String(name || '').trim().toLowerCase()
  if (!keyword) return null
  try {
    const map = await (kind === 'maps' ? maps() : kind === 'weapons' ? weapons() : agents())
    for (const item of map.values()) {
      const names = [item.displayName, item.developerName].filter(Boolean).map(n => String(n).toLowerCase())
      if (names.some(n => n === keyword || n.includes(keyword))) return item
    }
  } catch {}
  return null
}

/** 清掉静态数据缓存（`#瓦清缓存` 用） */
export async function clearStaticCache () {
  indexCache = {}
  try {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (file.endsWith('.json')) fs.rmSync(path.join(CACHE_DIR, file), { force: true })
    }
    return true
  } catch {
    return false
  }
}
