/**
 * 多账号凭证库 —— 「谁发的指令，就用谁的登录态」。
 *
 * ## 为什么需要它
 *
 * 掌瓦的接口只认 cookie 里那个人的身份，**没有任何「按名字查别人」的入口**。
 * 所以想让 A、B、C 三个群友各自看到自己的战绩，就不能共用一份 `mate.json`：
 * 只能每人一份登录态。这个模块就是那份「每人一份」的仓库。
 *
 * ## 目录约定
 *
 *   bridge/mate.json            基础配置（接口路径、武器表、默认参数），**所有人共用**
 *   bridge/accounts/<QQ>.json    该用户的凭证覆盖层（只有 login / role / updatedAt）
 *
 * 实际生效的配置 = 深合并(mate.json, accounts/<QQ>.json)。
 * 这样接口路径这类静态信息只维护一份，用户文件里只有会变的三样东西。
 *
 * ## 为什么不支持扫码登录
 *
 * 掌瓦的 cookie（access_token/openid/userId）和 body 里的 `scene` 是 QQ/微信
 * 原生 SDK 授权后由腾讯下发给**掌瓦 App 自己**的，签名在 App 里。我们在服务端
 * 复现不了这个流程 —— 这就是为什么这里只有「导入凭证」，没有「扫码登录」。
 * 详见 providers/mateapp.md。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 基础配置：所有人共用的那一份 */
export const CONFIG_PATH = process.env.MATE_CONFIG || path.join(HERE, 'mate.json')

/** 每用户覆盖层目录 */
export const ACCOUNTS_DIR = process.env.MATE_ACCOUNTS_DIR || path.join(HERE, 'accounts')

/** 仓库里带的模板（mate.json 本身在 .gitignore 里，不能随仓库分发） */
const EXAMPLE_PATH = path.join(HERE, 'providers/mateapp.example.json')

/**
 * 新装的实例是没有 `bridge/mate.json` 的 —— 它里面是登录 cookie，被 .gitignore
 * 挡着，仓库只带 `providers/mateapp.example.json` 这份模板。
 *
 * 结果就是「先有蛋还是先有鸡」又来一次：导入要读基础配置（baseUrl / endpoints），
 * 读配置又要求 mate.json 已经存在，而用户正是要**通过导入**才填得上凭证 ——
 * 于是第一句就卡死在「找不到掌瓦配置文件」，且提示让他去手抄模板。
 *
 * 所以缺了就从模板补一份：模板里有 baseUrl / endpoints / envelope，
 * 足够跑通验证，凭证随后由 saveCredential 写进 accounts/<user>.json。
 */
function ensureBase () {
  if (fs.existsSync(CONFIG_PATH)) return
  if (!fs.existsSync(EXAMPLE_PATH)) return
  try {
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH)
    console.log(`[gateway] bridge/mate.json 不存在，已从模板生成：${CONFIG_PATH}`)
  } catch (error) {
    console.log(`[gateway] 自动补 mate.json 失败：${error.message}`)
  }
}

/** 用户标识只允许这些字符，挡住 `../` 这类目录穿越 */
const SAFE_USER = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 把 user 压成能当文件名的 key。
 *
 * 以前这里遇到非法字符直接抛 BAD_REQUEST。问题是 **QQ 官方机器人的 `e.user_id`
 * 天生带冒号**（`群号:成员openid`，比如 `3889734773:11ABC2EAF…`），
 * 于是所有指令都被判 400，插件那边看到的就是「怎么都绑不上、名字也没错」。
 *
 * 现在改成**归一化**而不是拒绝：非法字符统一换成下划线，去掉首尾下划线，截断长度。
 * 关键是这套规则必须和插件侧 `utils/gateway.js` 的 `safeUser()` **逐字符一致** ——
 * 两边算出来的 key 不一样，就会变成「凭证在 A 名下、请求查 B」。
 *
 * 仍然挡住目录穿越：`.` 和 `/` 都会被换成 `_`，`../` 进不来。
 */
export function normalizeUser (user) {
  const key = String(user ?? '').trim()
  if (!key) return ''
  if (SAFE_USER.test(key)) return key
  return key
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96)
}

/* ---------------- 基础配置（mtime 缓存，改完不用重启） ---------------- */

let baseCache = { mtime: 0, config: null }

export function readBase () {
  ensureBase()

  let stat
  try {
    stat = fs.statSync(CONFIG_PATH)
  } catch {
    const error = new Error(
      `找不到掌瓦配置文件 ${CONFIG_PATH}。\n`
      + '  先复制一份模板：cp bridge/providers/mateapp.example.json bridge/mate.json\n'
      + '  再按 bridge/providers/mateapp.md 抓包把字段填进去。'
    )
    error.code = 'NOT_CONFIGURED'
    throw error
  }

  if (baseCache.config && stat.mtimeMs === baseCache.mtime) return baseCache.config

  let config
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch (error) {
    const wrapped = new Error(`掌瓦配置文件不是合法 JSON：${error.message}`)
    wrapped.code = 'NOT_CONFIGURED'
    throw wrapped
  }

  baseCache = { mtime: stat.mtimeMs, config }
  return config
}

/* ---------------- 覆盖层 ---------------- */

/** user → { mtime, config } */
const overlayCache = new Map()

function overlayPath (user) {
  return path.join(ACCOUNTS_DIR, `${normalizeUser(user)}.json`)
}

/** 读某个用户的凭证；没有就返回 null（不是错误 —— 「还没导入」是正常状态） */
export function readOverlay (user) {
  const key = normalizeUser(user)
  if (!key) return null

  const file = overlayPath(key)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    overlayCache.delete(key)
    return null
  }

  const hit = overlayCache.get(key)
  if (hit && hit.mtime === stat.mtimeMs) return hit.config

  let config
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    const wrapped = new Error(`accounts/${key}.json 不是合法 JSON：${error.message}`)
    wrapped.code = 'NOT_CONFIGURED'
    throw wrapped
  }

  overlayCache.set(key, { mtime: stat.mtimeMs, config })
  return config
}

/* ---------------- 深合并 ---------------- */

const isPlain = value => value && typeof value === 'object' && !Array.isArray(value)

/**
 * overlay 覆盖 base。
 *
 * 只合对象，数组直接替换 —— `weapons.map` 这类映射表整体覆盖比逐键合并更好理解：
 * 用户想改武器名，写几个键就覆盖几个，没写的仍走 base。
 */
function deepMerge (base, overlay) {
  const out = { ...base }
  for (const [key, value] of Object.entries(overlay || {})) {
    if (isPlain(value) && isPlain(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = value
  }
  return out
}

/**
 * 解析出「这次请求该用哪份配置」。
 *
 * - 不带 user（CLI 探针、健康检查）→ 用 base 自己的凭证
 * - 带 user 且导入过          → 深合并 base + overlay
 * - 带 user 但没导入          → 抛 NOT_BOUND（**绝不偷偷用 base 的凭证**，
 *                                否则每个群友都会看到机器人主人的战绩）
 * - base 里显式写了 allowShared: true 时才允许回退到 base（单人自用场景）
 */
export function resolveConfig (user) {
  const base = readBase()
  const key = normalizeUser(user)

  if (!key) {
    const config = { ...base }
    // 不写 __user，避免调用方误以为这是某个人的配置
    Object.defineProperty(config, '__user', { value: '', enumerable: false })
    return config
  }

  const overlay = readOverlay(key)
  if (!overlay) {
    if (base.allowShared === true) {
      const config = { ...base }
      Object.defineProperty(config, '__user', { value: key, enumerable: false })
      return config
    }
    const error = new Error(
      '你还没有导入过掌瓦登录态，所以我查不到你的战绩。\n'
      + '发 #瓦登录 看导入方法（掌瓦没有扫码登录，只能导入 App 的登录态）。'
    )
    error.code = 'NOT_BOUND'
    throw error
  }

  const config = deepMerge(base, overlay)
  Object.defineProperty(config, '__user', { value: key, enumerable: false })
  return config
}

/* ---------------- 写入 ---------------- */

function atomicWrite (file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * 保存一份凭证。
 *
 * 只落三个字段 + role 快照，接口路径这些不进用户文件 —— 免得以后升级
 * base 配置时，老用户的文件把它盖回去。
 */
export function saveAccount (user, { cookie, scene, sceneDetail, role, source = 'import' } = {}) {
  const key = normalizeUser(user)
  if (!key) {
    const error = new Error('保存凭证需要 user')
    error.code = 'BAD_REQUEST'
    throw error
  }
  if (!cookie) {
    const error = new Error('cookie 不能为空')
    error.code = 'BAD_REQUEST'
    throw error
  }

  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true })

  // 保留覆盖层里已有的其他字段（比如用户自己调过的 defaults），只更新凭证部分
  const previous = readOverlay(key) || {}
  const overlay = {
    ...previous,
    login: {
      ...(previous.login || {}),
      cookie,
      ...(scene ? { scene } : {}),
      ...(sceneDetail ? { sceneDetail } : {})
    },
    role: { ...(previous.role || {}), ...(role || {}) },
    updatedAt: new Date().toISOString(),
    source
  }

  atomicWrite(overlayPath(key), JSON.stringify(overlay, null, 2))
  overlayCache.delete(key)
  return overlay
}

export function removeAccount (user) {
  const key = normalizeUser(user)
  if (!key) return false
  try {
    fs.unlinkSync(overlayPath(key))
  } catch {
    return false
  }
  overlayCache.delete(key)
  return true
}

/**
 * 列出已导入的账号（**不回传 cookie**）。
 *
 * 网关是被插件调用的服务，它的响应会原样出现在聊天上下文里，
 * 所以这里只给「谁、什么时候、叫什么名字」，凭证本身永远不出网关。
 */
export function listAccounts () {
  let names = []
  try {
    names = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }

  return names.map(file => {
    const user = file.replace(/\.json$/, '')
    const overlay = readOverlay(user) || {}
    const role = overlay.role || {}
    return {
      user,
      name: role.name || '',
      uid: role.uid || '',
      updatedAt: overlay.updatedAt || '',
      // 只报「有没有 scene」，不报内容
      hasScene: !!overlay.login?.scene,
      hasSceneDetail: !!(overlay.login?.sceneDetail || overlay.login?.scene)
    }
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** 凭证是否完整到能发请求：cookie 必须有，scene 至少有一个 */
export function isUsable (user) {
  const overlay = readOverlay(user)
  if (!overlay?.login?.cookie) return false
  return !!(overlay.login.scene || readBase()?.login?.scene)
}
