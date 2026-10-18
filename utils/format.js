/**
 * 数值 / 时间格式化。
 *
 * 全部做成**永不抛异常**的纯函数：数据源返回的东西形状千奇百怪，
 * 这里少内外一个 NaN，出图上就是一片黑洞。统一在入口处把脏数据兜住，
 * 模板那边只管渲染。
 */

/** 任意值转数字，失败给兜底值 */
export function num (value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 0~1 的比例转百分数字符串
 * @param {number} value 0.4231
 * @param {number} digits 小数位
 */
export function pct01 (value, digits = 1) {
  if (value === null || value === undefined || value === '') return '—'
  return `${(num(value) * 100).toFixed(digits)}%`
}

/** 已经是百分数（0~100）的值转字符串 */
export function pct100 (value, digits = 1) {
  if (value === null || value === undefined || value === '') return '—'
  return `${num(value).toFixed(digits)}%`
}

/** 保留小数（默认两位，够了：ACS 这类数据再多只会显得乱） */
export function round (value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—'
  return num(value).toFixed(digits)
}

/** K/D 比 */
export function kd (kills, deaths) {
  const d = num(deaths)
  if (d <= 0) return num(kills).toFixed(2)
  return (num(kills) / d).toFixed(2)
}

/** KDA：((K + A) / D) */
export function kda (kills, deaths, assists) {
  const d = num(deaths)
  if (d <= 0) return (num(kills) + num(assists)).toFixed(2)
  return ((num(kills) + num(assists)) / d).toFixed(2)
}

/** 大数字加千分位 */
export function thousands (value) {
  return num(value).toLocaleString('zh-CN')
}

/**
 * 紧凑数字：11324 → 11.3k，1834704 → 1.83M
 *
 * 表格里塞 7 位数字会把相邻列挤到重叠（实测过），能省则省。
 */
export function compact (value) {
  const n = num(value)
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return thousands(n)
}

/** 秒 → 34:12 */
export function duration (seconds) {
  const total = Math.max(0, Math.round(num(seconds)))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 时间戳 → 相对时间
 * @param {number|string|Date} input 秒或毫秒均可（自动按位数判断）
 */
export function timeAgo (input) {
  let ts = 0
  if (input instanceof Date) ts = input.getTime()
  else {
    const n = num(input)
    ts = n > 1e12 ? n : n * 1000
  }
  if (!ts) return '未知时间'

  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 时间戳 → 日期时间 MM-DD HH:mm */
export function dateTime (input) {
  let ts = 0
  if (input instanceof Date) ts = input.getTime()
  else {
    const n = num(input)
    ts = n > 1e12 ? n : n * 1000
  }
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = v => String(v).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 比赛结果 → 展示文案 */
export function resultText (result) {
  const r = String(result || '').toLowerCase()
  if (r === 'win' || r === 'victory') return '胜利'
  if (r === 'lose' || r === 'defeat') return '失败'
  if (r === 'draw' || r === 'tie') return '平局'
  return '—'
}

/** 比赛结果 → 对应的 CSS 类（给模板用） */
export function resultClass (result) {
  const r = String(result || '').toLowerCase()
  if (r === 'win' || r === 'victory') return 'is-win'
  if (r === 'lose' || r === 'defeat') return 'is-lose'
  return 'is-draw'
}

/** 胜率 → 颜色档位（给面板上的数字条用） */
export function winRateLevel (rate) {
  const v = num(rate)
  if (v >= 0.55) return 'high'
  if (v >= 0.48) return 'mid'
  return 'low'
}

/** 队列/模式名兜底 */
export function modeText (mode, fallback = '—') {
  if (!mode) return fallback
  const map = {
    competitive: '竞技模式',
    unrated: '普通匹配',
    swiftplay: '快速模式',
    // ⚠️ 带空格的关键字必须加引号 —— `spike rush:` 这种写法在 JS 里是语法错误，
    //    而且报错定位在整条 import 链的顶端（"Unexpected token 'export'"），
    //    极难看出是这里挂了。调试时踩过一次，留个记号。
    'spike rush': '爆能快攻',
    spikerush: '爆能快攻',
    deathmatch: '死斗模式',
    escalation: '等级提升',
    replication: '阵容复制',
    snowball: '雪球大战',
    'team deathmatch': '团队死斗',
    premier: '晋级电竞',
    custom: '自定义',
    newmap: '新图快攻'
  }
  const key = String(mode).toLowerCase()
  return map[key] || String(mode)
}

/** 大区关键字 → 中文服名 */
export function regionText (region) {
  const map = {
    ap: '亚服',
    na: '美服',
    eu: '欧服',
    kr: '韩服',
    kr2: '韩服',
    br: '巴西服',
    latam: '拉美服',
    cn: '国服',
    // codev = 无畏契约手游（掌瓦）的 game_zone，接口里到处都是这个词
    codev: '国服手游',
    'china-mobile': '国服手游',
    'cn-mobile': '国服手游'
  }
  const key = String(region || '').toLowerCase()
  return map[key] || (region ? String(region) : '未知区服')
}

/** 把对象里的脏 key 去掉，避免传进模板后 art-template 报 undefined */
export function safe (obj, keys = []) {
  const out = {}
  for (const key of keys) out[key] = obj?.[key] ?? ''
  return out
}
