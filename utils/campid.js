/**
 * 掌瓦号 ↔ 登录态 的登记表。
 *
 * ## 为什么需要这张表
 *
 * 掌瓦（掌上无畏契约）的接口和王者营地**根本不是一回事**：
 *
 *   · 王者营地：给一个营地 ID，服务端就能查出这个人的战绩 —— ID 就是钥匙，谁都不用登录。
 *   · 掌瓦    ：所有 career 接口只认**登录态里的 scene**（一个 `v3_...` 的密文），
 *               请求体里的 `scene` 就是「查谁」的唯一开关。服务端**从不返回**掌瓦号，
 *               也没有「按号查人」的接口（`/go/customize_search/search` 是唯一的搜索路由，
 *               实测后端表 `admin_mval.mlol_customize_search` 都没建）。
 *
 * 所以掌瓦做不到「只凭一个号查任意人」。能做的、也是这里做的：
 * 把「掌瓦号 → 某份登录态」记在本地，绑定这个号就等于绑定那份登录态。
 *
 * 效果上和营地 ID 一样：发 `#瓦绑定 42035871`，之后 `#瓦面板` 出图。
 * 区别只有一条 —— 这个号**必须先有人扫过一次码**（掌瓦 3 天过期，过期要重扫）。
 *
 * ## 数据长什么样
 * ```json
 * {
 *   "42035871": {
 *     "user": "3889734773",     // bridge/accounts/<user>.json 的 key，取数用哪份登录态
 *     "name": "苦橘甘来",        // 登记时的游戏名，纯展示
 *     "owner": "3889734773",    // 谁登记的（安全压缩后的 QQ）
 *     "public": true,           // 别人能不能按这个号查
 *     "at": 1793983901
 *   }
 * }
 * ```
 *
 * 号码归属**接口上无法校验**（掌瓦不给这个字段），只能靠登记者声明。
 * 所以登记时要明说「如果这不是你的号，发 #瓦解除号 撤销」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'

const dataDir = PluginData
const dataFile = path.join(dataDir, 'CampIds.json')

/** 掌瓦号在 App 里是 9 位，留 8~10 位容错（前后不能有别的字符） */
const CAMP_ID_RE = /^\d{8,10}$/

function ensure () {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify({}, null, 2), 'utf8')
}

function read () {
  ensure()
  try {
    const json = JSON.parse(fs.readFileSync(dataFile, 'utf8') || '{}')
    return json && typeof json === 'object' ? json : {}
  } catch {
    // 写坏了不能让人彻底绑不上：备份一份，从空表继续
    try { fs.copyFileSync(dataFile, `${dataFile}.broken.${Date.now()}`) } catch {}
    return {}
  }
}

/** 先写临时文件再 rename：中途断电也不会留下半截 JSON */
function write (data) {
  ensure()
  const tmp = `${dataFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, dataFile)
}

/**
 * 把用户输入里的掌瓦号抠出来。
 *
 * 只在「整段就是 8~10 位数字」时才认 —— `#瓦绑定 42035871` 是号，
 * `#瓦战绩 42035871` 这种（当成条数/昵称）不归这里管。
 *
 * @returns {string} 认出来就返回规范化后的号码，否则空串
 */
export function normalizeCampId (raw) {
  const text = String(raw ?? '').trim().replace(/^[#＃]/, '').trim()
  return CAMP_ID_RE.test(text) ? text : ''
}

/** 这个号有没有登记过 */
export function findCampId (campId) {
  const id = normalizeCampId(campId)
  if (!id) return null
  const record = read()[id]
  return record ? { campId: id, ...record } : null
}

/** 某个登录态登记了哪些号 */
export function listCampIds (owner = '') {
  const key = String(owner || '')
  return Object.entries(read())
    .map(([campId, record]) => ({ campId, ...record }))
    .filter(record => !key || String(record.owner || '') === key)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
}

/**
 * 登记一个号。
 *
 * 同一个号重复登记 = 覆盖（换人扫了新的登录态时就是这条路）。
 *
 * @param {string} campId
 * @param {{user: string, name?: string, owner?: string, public?: boolean}} meta
 */
export function registerCampId (campId, { user, name = '', owner = '', public: isPublic = true } = {}) {
  const id = normalizeCampId(campId)
  if (!id) throw new Error('不是掌瓦号格式')
  if (!user) throw new Error('缺少登录态标识')

  const data = read()
  const before = data[id] || {}
  data[id] = {
    user: String(user),
    name: String(name || before.name || ''),
    owner: String(owner || before.owner || user),
    // 老记录没这个字段时按公开处理（和营地 ID 的行为一致）
    public: isPublic === undefined ? (before.public !== false) : !!isPublic,
    at: Math.floor(Date.now() / 1000)
  }
  write(data)
  return { campId: id, ...data[id] }
}

/** 撤销登记，返回撤掉的那条（没有就 null） */
export function removeCampId (campId) {
  const id = normalizeCampId(campId)
  if (!id) return null
  const data = read()
  const record = data[id]
  if (!record) return null
  delete data[id]
  write(data)
  return { campId: id, ...record }
}

/**
 * 这份登录态绑着哪个掌瓦号（反查，用来在 `#瓦账号` 里显示）。
 * 一个登录态理论上只对应一个号，取最近登记的那个。
 */
export function campIdOf (user) {
  const key = String(user || '')
  if (!key) return ''
  const hit = listCampIds().find(record => String(record.user) === key)
  return hit?.campId || ''
}

/**
 * 发请求时该用哪份登录态。
 *
 * 普通账号没有 `campUser`，用调用者自己；按掌瓦号绑定的账号，
 * 取数要用**登记这个号的那个人**的登录态（掌瓦只能查登录态自己的数据）。
 */
export function credentialUser (account, fallback = '') {
  return String(account?.campUser || fallback || '')
}

/**
 * 发请求时「查谁」那一栏该填什么。
 *
 * 掌瓦的聚合接口（赛季总览 / 表现）只认登录态自己，传别人的名字会直接
 * `result=1002`；网关也据此做了一层拦截（`getProfile` 里那个「只认自己的登录态」）。
 * 按掌瓦号绑定的账号，`id` 是那串数字，网关自然不认 —— 所以这里统一换成
 * **空串**，语义就是「这份登录态的自己」，网关和上游都按这个走。
 *
 * 普通账号（昵称 / Riot ID / 同场玩家）原样返回，别动它们。
 */
export function queryAccount (account) {
  if (account?.campUser) return ''
  return String(account?.id || '')
}
