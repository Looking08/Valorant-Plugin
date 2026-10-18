/**
 * 登录态导入（`#瓦登录` / `#瓦导入` / `#瓦退出登录` / `#瓦登录状态`）。
 *
 * ## 为什么不是「扫码登录」
 *
 * 掌瓦的登录态 = cookie（`access_token/openid/userId`）+ 请求体里的 `scene`，
 * 两者都是 QQ/微信 原生 SDK 授权后由腾讯下发给**掌瓦 App 自己**的，签名在 App 里。
 * 服务端复现不了这个流程，所以「扫码就能查」在掌瓦这条路上不成立
 * （实测过 QQ 扫码被 TLS 指纹风控、微信网页版拿到的是微信会话、调不了 mval）。
 *
 * ## 那这里做什么
 *
 * 把「抓包 → 抄三个值 → 发给我」这条路铺平：一人导入一次，网关按 QQ 号分别存，
 * 之后谁发指令就查谁自己的数据，互不相干。
 *
 * 导入格式（两种都认）：
 *   1) `#瓦导入 <cookie>|<scene>|<sceneDetail>`      —— 一行搞定，桌面端最方便
 *   2) 多行 key=value                                 —— 手机端照抄标签不容易错
 *      ```
 *      #瓦导入
 *      cookie=clientType=9; appid=...; access_token=...;
 *      scene=v3_xxx
 *      sceneDetail=v3_yyy
 *      ```
 *
 * 电脑上抓的 HAR 不用手抄：`node tools/har2cred.mjs 抓包.har` 会直接打出这一行。
 */
import {
  credentialStatus,
  importCredential,
  removeCredential,
  saveUserInfo,
  parseRiotId,
  GatewayError
} from '#utils'

/**
 * 抓包步骤 —— 按「只有一台手机 + QQ」的用户写。
 *
 * 关键选择：让用户复制 **cURL**，而不是手抄 cookie / scene。
 * 抓包 App 基本都有「复制为 cURL」这个按钮，点一下就得到一整段；
 * 手抄 638 字符的 cookie 必错，而且多半会漏掉 `tid` 那段。
 */
const STEPS = [
  '① 手机装个抓包 App：安卓用 Reqable / HttpCanary，iPhone 用 Stream / Thor。按它引导装好证书',
  '   iPhone 装完还要去「设置 → 通用 → 关于本机 → 证书信任设置」把开关打开',
  '② 开着抓包打开掌上无畏契约，进「我的 → 战绩」，往下滑一点，再点进任意一局',
  '③ 回到抓包 App，按 app.mval.qq.com 过滤，找到 career/record/list 这条请求',
  '④ 长按它 → 选「复制为 cURL」（有的 App 叫「复制请求」「Copy as cURL」）',
  '⑤ 再找 career/record/player/rounds 那条，同样复制一份',
  '⑥ 回来发：#瓦导入 然后把复制到的两段一起粘贴发给我'
]

/** 有效期说明 —— 掌瓦的登录态会过期，提前讲清楚省得以为是插件坏了 */
const EXPIRE_NOTE = '掌瓦的登录态会过期（一般几天到两周），过期后查询会提示「登录态失效」，重新抓一次包再导入即可。'

const PC_TIP = '有电脑的话可以省掉复制：在插件目录跑 node tools/har2cred.mjs 抓包.har --docker --user=你的QQ号 --token=网关令牌。'

const TUTORIAL = [
  '【为什么要导入】',
  '掌瓦没有对外开放的扫码登录 —— 登录态是 App 内部签名的，服务端拿不到。',
  '所以「登录」在这里 = 把你抓包得到的登录态交给我，每人一份，各查各的。',
  '',
  '【怎么抓】',
  ...STEPS,
  '',
  '【我认什么格式】',
  '· cURL（推荐，抓包 App 里一键复制）',
  '· 抓包 App 里「复制请求」得到的整段原始请求',
  '· 或者手动：#瓦导入 <cookie>|<scene>|<sceneDetail>',
  '两条请求一起发最好（列表 + 逐回合）；只发一条也能用，只是详情页可能查不出来。',
  '',
  '【说明】',
  EXPIRE_NOTE,
  PC_TIP
].join('\n')

export class ValorantLogin extends plugin {
  constructor () {
    super({
      name: '瓦插件_登录态',
      dsc: '无畏契约登录态导入（一人一份）',
      event: 'message',
      priority: 1000,
      rule: [
        // 顺序有意义：Yunzai 同插件内命中即 return
        { reg: '^#?瓦登录状态$', fnc: 'status' },
        { reg: '^#?瓦(退出|解绑)登录$', fnc: 'logout' },
        { reg: '^#?瓦(导入|上传)(登录态|凭证)?[\\s\\S]*$', fnc: 'importCred' },
        // 用户很可能直接把 cURL 粘过来、忘了带指令。只认「以 curl 开头且指向掌瓦」
        // 这一种，别把别的内容也吞进来（这条正则很容易写宽，宽了就是灾难）。
        { reg: "^\\s*curl\\s+['\"]?https://app\\.mval\\.qq\\.com", fnc: 'importCred' },
        { reg: '^#?瓦扫码登录[\\s\\S]*$', fnc: 'scanExplain' },
        { reg: '^#?瓦登录[\\s\\S]*$', fnc: 'status' }
      ]
    })
  }

  /* ---------------- 查状态 ---------------- */

  async status (e) {
    let info
    try {
      info = await credentialStatus(e.user_id)
    } catch (error) {
      await e.reply(explain(error))
      return true
    }

    if (!info?.bound) {
      await e.reply(['你还没有导入登录态，所以我查不到你的战绩。', '', TUTORIAL].join('\n'))
      return true
    }

    const role = info.role || {}
    const when = info.updatedAt ? new Date(info.updatedAt).toLocaleString('zh-CN') : '未知'
    await e.reply([
      '✅ 已导入登录态',
      `角色：${role.name || '（没认出来，可能登录态已失效）'}`,
      role.uid ? `UID：${role.uid}` : '',
      `导入时间：${when}`,
      info.usable ? '' : '⚠️ 凭证不完整（缺 cookie 或 scene），重新导入一次',
      '',
      '直接发 #瓦面板 / #瓦战绩 就是查你自己的数据。',
      '想换号：#瓦退出登录 后重新导入。'
    ].filter(Boolean).join('\n'))
    return true
  }

  /* ---------------- 导入 ---------------- */

  async importCred (e) {
    const raw = e.msg.replace(/^#?瓦(导入|上传)(登录态|凭证)?/, '').trim()

    // 只发了文件/截图、没有文字：我们的协议端（OneBot/Milky）拿不到群文件直链，
    // 截图更不行（638 字符的 cookie 靠 OCR 认不准）。与其静默失败，不如说清楚。
    if (!raw && hasAttachment(e)) {
      await e.reply([
        '文件或截图我这边都用不了 —— 机器人拿不到群文件的下载地址（协议端限制），',
        '截图也不行：cookie 有 600 多字符，识别一定会错字。',
        '',
        '换个方式：抓包 App 里长按那条请求 →「复制为 cURL」→ 发',
        '#瓦导入 然后把复制到的内容粘上来（纯文本）',
        '',
        TUTORIAL
      ].join('\n'))
      return true
    }

    if (!raw) {
      await e.reply(TUTORIAL)
      return true
    }

    const payload = parsePayload(raw)
    if (!payload?.cookie) {
      await e.reply([
        '这段我认不出来，里面没有掌瓦的 cookie。',
        '',
        '最快的做法：抓包 App 里长按 app.mval.qq.com 的请求 →「复制为 cURL」→ 直接粘给我。',
        '整段原样粘就行，不用你删减 —— URL、Cookie、请求体我会自己拆。',
        '',
        '手动格式（不推荐，容易抄错）：#瓦导入 <cookie>|<scene>|<sceneDetail>',
        '',
        TUTORIAL
      ].join('\n'))
      return true
    }

    if (!payload.scene) {
      await e.reply([
        'cookie 收到了，但还差 scene —— 只有 cookie 我查不了。',
        '',
        'scene 在请求体里（v3_ 开头那串），所以别只复制 Cookie 头：',
        '在抓包 App 里对 career/record/list 这条请求点「复制为 cURL」，',
        'URL + 请求头 + 请求体一次就都带上了。',
        '',
        '它跟你这个账号绑定，不能借用别人的。',
        PC_TIP
      ].join('\n'))
      return true
    }

    if (payload.scene.length < 8) {
      await e.reply('scene 看起来太短了（正常是 v3_ 开头、几十上百个字符）。检查一下是不是抄漏了。')
      return true
    }

    await e.reply('收到，正在用这份登录态打一次真实请求验证…').catch(() => {})

    let result
    try {
      result = await importCredential(e.user_id, payload)
    } catch (error) {
      await e.reply(explain(error))
      return true
    }

    const name = result?.role?.name || ''
    if (name) bindOwnAccount(e.user_id, name, result?.role?.uid || '')

    await e.reply([
      '✅ 导入成功，登录态已验证可用',
      name ? `角色：${name}` : '（角色名没认出来，但接口已能正常返回数据）',
      '',
      name
        ? '现在直接发 #瓦面板 / #瓦战绩，查的就是你自己的数据。'
        : '先发 #瓦面板 试试；如果为空，发 #瓦登录状态 看看。',
      EXPIRE_NOTE
    ].filter(Boolean).join('\n'))
    return true
  }

  /* ---------------- 退出 ---------------- */

  async logout (e) {
    let info
    try {
      info = await credentialStatus(e.user_id)
    } catch (error) {
      await e.reply(explain(error))
      return true
    }

    if (!info?.bound) {
      await e.reply('你本来就没导入过登录态，不用退出。')
      return true
    }

    try {
      await removeCredential(e.user_id)
    } catch (error) {
      await e.reply(explain(error))
      return true
    }

    await e.reply('已删除你的登录态。\n想换号就发 #瓦登录 重新导入一次。')
    return true
  }

  /* ---------------- 扫码（说明为什么没有） ---------------- */

  async scanExplain (e) {
    await e.reply([
      '掌瓦没法扫码登录，不是没做，是这条路不通：',
      '',
      '· 登录态 = cookie（access_token/openid/userId）+ 请求体里的 scene，',
      '  都是 QQ/微信 授权后由腾讯直接下发给掌瓦 App 的，签名在 App 里；',
      '· 我们试过 QQ 扫码（被风控挡）、微信网页版（拿到的是微信会话，调不了掌瓦接口）；',
      '· 微信开放平台「网站应用」换来的 openid 也对不上掌瓦的 appid。',
      '',
      '所以只能导入登录态，一人一份：',
      '#瓦登录 看步骤'
    ].join('\n'))
    return true
  }
}

/* ---------------- 工具 ---------------- */

/**
 * 解析用户粘贴的内容。
 *
 * 群友普遍只有一台手机 + QQ，不可能去跑命令行，所以这里尽量**收下抓包工具
 * 原样导出的东西**，而不是要求他们照着格式抄：
 *
 *   1. cURL（Reqable / Charles / Thor / Reqable 手机版都能一键复制）
 *      curl 'https://app.mval.qq.com/...' -H 'cookie: clientType=9; ...' --data-raw '{"scene":"v3_..."}'
 *   2. 原始 HTTP 请求（有的工具导出的是这种，带 `Cookie:` 头 + JSON body）
 *   3. 一行 `cookie|scene|sceneDetail`
 *   4. 多行 `cookie=...` / `scene=...`
 *   5. 只贴了 cookie（此时会告诉用户还差 scene）
 *
 * 还能同时贴**两条**请求（列表 + 逐回合）—— 会按 body 里的
 * `baton` / `battle_id` 自己分清哪个是 scene、哪个是 sceneDetail。
 */
export function parsePayload (text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return null

  // 1) cURL
  if (/(^|\n)\s*curl\s/i.test(raw) || /--data(-raw|-binary|-urlencode)?\s/i.test(raw)) {
    const cookie = curlHeader(raw, 'cookie')
    const scenes = classifyScenes(raw)
    return scenes.cookieHint || cookie
      ? {
          cookie: cookie || '',
          scene: scenes.list,
          sceneDetail: scenes.detail || scenes.list
        }
      : null
  }

  // 2) 原始 HTTP 请求：有 `Cookie:` 头
  if (/(^|\n)\s*cookie\s*:/i.test(raw)) {
    const m = raw.match(/(^|\n)\s*cookie\s*:\s*([^\n]+)/i)
    const scenes = classifyScenes(raw)
    return {
      cookie: m ? m[2].trim() : '',
      scene: scenes.list,
      sceneDetail: scenes.detail || scenes.list
    }
  }

  // 3) 多行 key=value
  if (/(^|\n)\s*cookie\s*=/i.test(raw)) {
    const out = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(cookie|scene|scene_?detail)\s*=\s*(.+)$/i)
      if (!m) continue
      const key = m[1].toLowerCase().replace(/_/g, '')
      out[key] = m[2].trim().replace(/^["'`]|["'`]$/g, '')
    }
    if (!out.cookie) return null
    return {
      cookie: out.cookie,
      scene: out.scene || '',
      sceneDetail: out.scenedetail || out.scene || ''
    }
  }

  // 4) 一行竖线分隔
  const parts = raw.split('|').map(s => s.trim()).filter(Boolean)
  if (parts.length >= 2 && /access_token|clientType|userId=/i.test(parts[0])) {
    return { cookie: parts[0], scene: parts[1], sceneDetail: parts[2] || parts[1] }
  }

  // 5) 只贴了 cookie（没有 scene，交给上层提示「还差 scene」）
  if (/access_token|clientType|userId=/i.test(raw)) {
    return { cookie: raw, scene: '', sceneDetail: '' }
  }

  return null
}

/** 从 cURL 的 `-H 'cookie: ...'` 里取值（也认 `--header`） */
function curlHeader (text, name) {
  const re = new RegExp(`(?:-H|--header)\\s+(['"])${name}\\s*:\\s*([\\s\\S]*?)\\1`, 'i')
  const m = text.match(re)
  return m ? m[2].trim() : ''
}

/**
 * 把文本里所有 `{"...scene..."}` 的 JSON 体捞出来，按内容分成「列表」和「详情」。
 *
 * 为什么要分类：列表请求的 body 里有 `baton` / `mode_filter`，逐回合请求的
 * body 里有 `battle_id` / `game_mode`。用户经常只贴其中一条，如果当成同一个
 * scene 用，详情页会查不出来（而且接口不报错，只给空数组，非常难查）。
 */
function classifyScenes (text) {
  const out = { list: '', detail: '', cookieHint: false }
  for (const body of extractJsonBodies(text)) {
    if (!body.scene) continue
    if (body.battle_id) {
      // 逐回合 / 记分板都带 battle_id，但只有 player/rounds 的 scene 是详情专用
      if (body.game_mode && !out.detail) out.detail = body.scene
      else if (!out.detail) out.detail = body.scene
    } else if (body.baton !== undefined || body.mode_filter !== undefined) {
      if (!out.list) out.list = body.scene
    } else if (!out.list) {
      out.list = body.scene
    }
  }
  // 只有一条时两处共用，至少列表能查
  if (!out.list && out.detail) out.list = out.detail
  return out
}

/**
 * 从任意文本里抠出含 scene 的 JSON 对象。
 *
 * 不用 `JSON.parse(整段)`：cURL 里混着 URL、引号、转义，整段不是合法 JSON。
 * 这里扫 `{` 并做括号配平（跳过字符串里的括号），只对每个候选体单独 parse。
 */
function extractJsonBodies (text) {
  const bodies = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue
    const end = matchBrace(text, i)
    if (end < 0) continue
    const slice = text.slice(i, end + 1)
    if (!slice.includes('scene')) continue
    try {
      const parsed = JSON.parse(slice.replace(/\\"/g, '"'))
      if (parsed && typeof parsed === 'object' && parsed.scene) bodies.push(parsed)
    } catch {}
    i = end
  }
  return bodies
}

/** 从 `start` 处的 `{` 找配对的 `}`，跳过字符串内的括号；找不到返回 -1 */
function matchBrace (text, start) {
  let depth = 0
  let quote = ''
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 这条消息里有没有附件（文件 / 图片）。
 *
 * 不同协议端给的结构不一样（`e.file`、`e.message[]` 里的 file/image segment），
 * 这里只做「有没有」的判断，不尝试下载 —— 下载各端差异太大，宁可明确说不支持。
 */
function hasAttachment (e) {
  if (e?.file) return true
  const list = Array.isArray(e?.message) ? e.message : []
  return list.some(m => m?.type === 'file' || m?.type === 'image' || m?.type === 'video')
}

/** 导入成功后把自己的角色绑上，这样 #瓦面板 不用再手动绑定 */
function bindOwnAccount (userId, name, uid) {
  const parsed = parseRiotId(name) || { id: name, name, tag: '' }
  return saveUserInfo(userId, current => {
    const accounts = Array.isArray(current.accounts) ? current.accounts : []
    const idx = accounts.findIndex(a => a.id.toLowerCase() === parsed.id.toLowerCase())
    const record = { ...parsed, region: '', note: uid ? `登录态 ${uid}` : '登录态导入' }

    if (idx >= 0) {
      accounts[idx] = { ...accounts[idx], ...record }
      return { ...current, accounts, current: idx }
    }
    accounts.push(record)
    return { ...current, accounts, current: accounts.length - 1 }
  })
}

/** 把网关错误翻译成「用户能照着做」的话 */
function explain (error) {
  if (!(error instanceof GatewayError)) {
    return `导入失败：${error?.message || error}`
  }

  switch (error.code) {
    case 'NO_GATEWAY':
    case 'UNREACHABLE':
      return error.message

    case 'NOT_BOUND':
      // 理论上走不到（导入前不该查数据），但真出现了就说清楚
      return error.message

    case 'NOT_SUPPORTED':
      return [
        error.message,
        '',
        '当前数据源不支持按人导入登录态。',
        '换成 PROVIDER=mateapp 起网关即可。'
      ].join('\n')

    case 'UPSTREAM_AUTH':
      return [
        error.message,
        '',
        '这种情况通常是：cookie / scene 抄漏了，或者抓包时登录态已经过期。',
        '重新抓一次，注意 Cookie 要整条复制（以 clientType= 开头那串）。'
      ].join('\n')

    default:
      return error.message
  }
}

export default ValorantLogin
