/**
 * 「这次要查哪个账号」的统一解析。
 *
 * 四个 app（面板 / 战绩 / 详情 / 枪械）都要处理同一件事，抽出来避免各写一份
 * 导致行为不一致（最典型的 bug：战绩列表里点了详情，结果查到了别人的账号）。
 *
 * 优先级：**指令里带的 name#tag > @ 的那个人 > 调用者自己绑定的当前账号**
 */
import { getCurrentAccount, getUserInfo, parseRiotId } from './store.js'
import { listPeers } from './gateway.js'

/** 需要用户先绑定的提示 */
export class NeedBind extends Error {
  constructor (message = '') {
    super(message)
    this.name = 'NeedBind'
  }
}

/** 给了昵称，但这个人查不到 */
export class UnknownPeer extends Error {
  constructor (name = '') {
    super([
      `没找到「${name}」。`,
      '',
      '掌瓦没有按昵称搜人的接口，所以只有跟你同过一场的人才查得到。',
      '发 #瓦同场 看看现在收录了谁。'
    ].join('\n'))
    this.name = 'UnknownPeer'
  }
}

const BIND_HINT = [
  '还没有绑定账号，先绑定一个再看数据：',
  '· #瓦绑定 你的名称#标签     例：#瓦绑定 张三#1234',
  '· 也可以不绑定直接查：#瓦战绩 张三#1234'
].join('\n')

/**
 * @param {object} e 云崽事件
 * @param {string} raw 指令里跟在后面的参数
 * @param {object} opts { allowAt: 是否允许 @ 他人 }
 * @returns {{ account: {id,name,tag,region}, fromUser: string|null }}
 */
export function resolveAccount (e, raw = '', opts = {}) {
  const allowAt = opts.allowAt !== false

  // 1. 显式指定：张三#1234
  const parsed = parseRiotId(raw)
  if (parsed) {
    const region = extractRegion(raw.replace(parsed.id, ''))
    return { account: { ...parsed, region: region || 'ap' }, fromUser: null }
  }

  // 2. @ 了别人：查他的当前账号
  const atId = allowAt && e.at && !e.atme ? String(e.at) : ''
  if (atId) {
    const acc = getCurrentAccount(atId)
    if (!acc) throw new NeedBind('这位朋友还没绑定账号，先用 #瓦绑定 名称#标签 绑一个吧。')
    return { account: acc, fromUser: atId }
  }

  // 3. 自己绑定的当前账号
  const self = getCurrentAccount(e.user_id)
  if (!self) {
    const { info } = getUserInfo(e.user_id)
    if (info.accounts?.length) throw new NeedBind(BIND_HINT)
    throw new NeedBind(BIND_HINT)
  }
  return { account: self, fromUser: String(e.user_id) }
}

/**
 * 指令参数里「像昵称」的那部分。
 *
 * `#瓦战绩 20`（条数）、`#瓦战绩 张三#1234`（Riot ID）、`#瓦战绩 ap`（大区）
 * 都不是昵称，一律返回空串 —— 空串 = 「用户没指名道姓」，照原逻辑走。
 */
export function pickName (raw = '') {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (/^\d{1,3}$/.test(text)) return ''
  if (parseRiotId(text)) return ''
  return text
    // 只删「独立成词」的数字和大区，昵称里自带的数字（abc123）不能动
    .replace(/(?:^|\s)\d{1,3}(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)(?:ap|na|eu|kr|br|latam|cn)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 昵称归一化：去空白和尖括号、转小写（跟网关那边的 normalizeName 对齐） */
function norm (name) {
  return String(name || '').replace(/[<>\s]/g, '').toLowerCase()
}

/**
 * 按昵称找「查得到的人」。
 *
 * 掌瓦没有按昵称搜人的接口，唯一的钥匙是 scene —— 而每个人的 scene 都会被
 * 服务端发给同场十个人。所以能查的只有：自己的小号 + 跟你同过一场的人。
 *
 * @returns {Promise<{id,name,tag,region,peer:boolean}|null>} null = 没指名，交给调用方兜底
 */
async function lookupName (e, name) {
  const key = norm(name)
  if (!key) return null

  // 1. 叫的就是自己的主账号 —— 走正常流程，别绕一圈
  const self = getCurrentAccount(e.user_id)
  if (self && norm(self.name) === key) return null

  // 2. 自己绑过的其它账号（小号）
  const { info } = getUserInfo(e.user_id)
  const mine = (info.accounts || []).find(a => norm(a.name) === key)
  if (mine) return { ...mine, peer: false }

  // 3. 同过场的人。网关连不上就返回 null，别挡着正常查询
  let peers = []
  try {
    peers = await listPeers(String(e.user_id || ''))
  } catch {
    return null
  }
  if (!peers?.length) return null

  const hit = peers.find(p => norm(p.name) === key)
    || peers.find(p => norm(p.name).includes(key))
  if (!hit) return null

  return { id: hit.name, name: hit.name, tag: '', region: '', peer: true }
}

/**
 * 带昵称解析的账号定位（`#瓦战绩 鱼香肉丝`）。
 *
 * 先试昵称，没指名就退回 `resolveAccount`；指了名但查不到会抛 `UnknownPeer`
 * —— 静默退回自己的账号是最糟的结果：用户会以为查到了别人。
 */
export async function resolveTarget (e, raw = '', opts = {}) {
  const name = pickName(raw)
  if (name) {
    const peer = await lookupName(e, name)
    if (peer) return { account: peer, fromUser: null }
    throw new UnknownPeer(name)
  }
  return resolveAccount(e, raw, opts)
}

/** 从参数尾部抠出大区关键字：ap / na / eu / cn … */
function extractRegion (text) {
  const m = String(text || '').match(/\b(ap|na|eu|kr|br|latam|cn)\b/i)
  return m ? m[1].toLowerCase() : ''
}

/** 关键字是否像 名称#标签 */
export function looksLikeRiotId (raw) {
  return !!parseRiotId(raw)
}
