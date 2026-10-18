/**
 * 「这次要查哪个账号」的统一解析。
 *
 * 四个 app（面板 / 战绩 / 详情 / 枪械）都要处理同一件事，抽出来避免各写一份
 * 导致行为不一致（最典型的 bug：战绩列表里点了详情，结果查到了别人的账号）。
 *
 * 优先级：**指令里带的 name#tag > @ 的那个人 > 调用者自己绑定的当前账号**
 */
import { getCurrentAccount, getUserInfo, parseRiotId } from './store.js'

/** 需要用户先绑定的提示 */
export class NeedBind extends Error {
  constructor (message = '') {
    super(message)
    this.name = 'NeedBind'
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

/** 从参数尾部抠出大区关键字：ap / na / eu / cn … */
function extractRegion (text) {
  const m = String(text || '').match(/\b(ap|na|eu|kr|br|latam|cn)\b/i)
  return m ? m[1].toLowerCase() : ''
}

/** 关键字是否像 名称#标签 */
export function looksLikeRiotId (raw) {
  return !!parseRiotId(raw)
}
