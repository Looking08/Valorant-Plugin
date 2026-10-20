/**
 * 登录（`#瓦扫码登录` / `#瓦登录` / `#瓦导入` / `#瓦退出登录` / `#瓦登录状态`）。
 *
 * ## 两条路，扫码是首选
 *
 * 1. **扫码**（`#瓦扫码登录`）：机器人出一张 QQ 码，手机 QQ 扫一下确认，
 *    网关拿 QQ 的 openid/access_token 去 `login_by_qq` 换掌瓦自己的凭证，
 *    再问 `get_main_role_raw` 要角色名和 scene。全程不用抓包。
 * 2. **导入**（`#瓦导入`）：抓包抄 cookie + scene。扫码走不通时的兜底
 *    （比如服务器连不上 xui.ptlogin2.qq.com，或者 QQ 侧风控）。
 *
 * 两条路最后都落成同一份东西：cookie + scene，按 QQ 号分开存，
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
  loginAdapters,
  loginStart,
  loginPoll,
  loginCancel,
  loginCommit,
  saveUserInfo,
  parseRiotId,
  login as loginCfg,
  GatewayError
} from '#utils'
import { parsePayload } from '../utils/payload.js'

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
  '【最快的方式】',
  '直接发 #瓦扫码登录，我给你一张二维码，用手机 QQ 扫一下确认就行。',
  '',
  '【扫码不行就抓包】',
  '扫码依赖 QQ 的登录页，服务器连不上或被风控时就只能导入。',
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
        { reg: '^#?瓦扫码登录[\\s\\S]*$', fnc: 'scanLogin' },
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
      await e.reply([
        '你还没有登录，所以我查不到你的战绩。',
        '',
        '发 #瓦扫码登录，用手机 QQ 扫一下就完事（不用抓包）。',
        '',
        ...(TUTORIAL.split('\n'))
      ].join('\n'))
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

  /* ---------------- 扫码登录 ---------------- */

  /**
   * 出码 → 轮询 → 落库。
   *
   * 轮询放在这条指令里同步跑完（最长 2 分钟），不引入「上下文」那套状态机：
   * 群里同时有两个人扫码的场面很常见，靠 e.user_id 各跑各的反而更简单，
   * 也不会出现「上一轮的码把这一轮的结果顶掉」。
   */
  async scanLogin (e) {
    // 命名避开 `login`：这个类的方法叫 scanLogin，但 import 的 login() 同名会遮住
    const cfg = loginCfg()
    const ttl = cfg.pollSeconds
    const every = cfg.pollInterval

    let adapters = []
    try {
      adapters = await loginAdapters()
    } catch (error) {
      await e.reply(explain(error))
      return true
    }
    if (!adapters.includes('qq')) {
      await e.reply([
        '网关没有挂载 QQ 扫码适配器，只能用导入的方式：',
        '#瓦登录 看抓包步骤'
      ].join('\n'))
      return true
    }

    await e.reply('正在向 QQ 要二维码…').catch(() => {})

    // 先把话说清楚再发码 —— 2026-10 实测：腾讯把掌瓦 appid 的 check_sig 前置机下线了，
    // 扫完能确认，但最后换 token 那一步的域名是死的。发码之前提醒，总比让人扫完一脸问号好。
    await e.reply([
      '⚠️ 先说一句：扫码登录目前在腾讯侧走不通。',
      '能出码、能扫、手机上也能确认，但最后一步「拿 token」的地址被腾讯下线了，到不了终点。',
      '',
      '想试就扫下面这张；想真能用，走导入：发 #瓦导入（抓包），一次能管很久。'
    ].join('\n')).catch(() => {})

    let session
    try {
      session = await loginStart(cfg.type, e.user_id)
    } catch (error) {
      await e.reply([
        explain(error),
        '',
        '扫码走不通时可以退回抓包导入：发 #瓦登录 看步骤。'
      ].join('\n'))
      return true
    }

    const image = dataUrlToBuffer(session.qr)
    const tip = [
      '用手机 QQ 扫码，扫完在手机上点「确认登录」——只扫不点没用。',
      ttl
        ? `码两分钟左右失效，我这边替你盯 ${ttl} 秒；过期了就重发 #瓦扫码登录。`
        : '码两分钟左右失效，过期了重发 #瓦扫码登录。'
    ].join('\n')

    // 跟 replyImage 一个路数：直接把 Buffer 丢给 e.reply。
    // 不拼 segment 数组 —— 有的协议端对「图 + 文字」混排支持得不好，
    // 二维码发不出去就整个流程卡死了，分开发稳一点。
    if (image) {
      await e.reply(image).catch(() => {})
    }
    await e.reply(tip)

    // pollSeconds=0 表示不自动盯，用户自己发 #瓦登录状态 查
    if (!ttl) {
      await e.reply('二维码已经发出去了。扫完确认后用 #瓦登录状态 看结果。')
      return true
    }

    // ---- 轮询 ----
    const deadline = Date.now() + ttl * 1000
    let said = 'waiting'
    let last = null

    while (Date.now() < deadline) {
      await sleep(every * 1000)
      try {
        last = await loginPoll(session.sessionId)
      } catch {
        continue
      }
      if (!last) continue

      if (last.status === 'scanned' && said !== 'scanned') {
        said = 'scanned'
        await e.reply('已扫码，等你在手机上点「确认登录」…').catch(() => {})
        continue
      }

      if (last.status === 'confirmed') break

      if (last.status === 'expired' || last.status === 'blocked' || last.status === 'cancelled') {
        await loginCancel(session.sessionId).catch(() => {})
        await e.reply([
          last.message || '这次没扫成。',
          '',
          last.status === 'blocked'
            ? 'QQ 那边没响应，通常是风控，重发一次 #瓦扫码登录 往往就好了。'
            : '再来一次：发 #瓦扫码登录',
          '老是失败的话改用抓包导入：发 #瓦登录 看步骤。'
        ].join('\n'))
        return true
      }
    }

    if (last?.status !== 'confirmed') {
      await loginCancel(session.sessionId).catch(() => {})
      await e.reply('等太久了，这次先取消。想再试就发 #瓦扫码登录。')
      return true
    }

    // ---- 落库 ----
    let saved
    try {
      saved = await loginCommit(session.sessionId, e.user_id)
    } catch (error) {
      await e.reply(explain(error))
      return true
    }

    if (saved?.saved === false) {
      await e.reply([
        '扫码成功了，但凭证没能存下来。',
        saved.hint || '',
        '',
        '换成抓包导入一定能用：发 #瓦登录 看步骤。'
      ].filter(Boolean).join('\n'))
      return true
    }

    const role = saved?.role || {}
    if (cfg.autoBind && role.name) bindOwnAccount(e.user_id, role.name, role.uid || '')

    await e.reply([
      '✅ 扫码登录成功',
      role.name ? `角色：${role.name}${role.tierText ? `（${role.tierText}）` : ''}` : '',
      '',
      '现在直接发 #瓦面板 / #瓦战绩 就是查你自己的数据。',
      '登录态会过期，失效了重新扫一次即可；换号先 #瓦退出登录。'
    ].filter(Boolean).join('\n'))
    return true
  }
}

/* ---------------- 工具 ---------------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `data:image/png;base64,xxxx` → Buffer。
 * 网关回的就是这个格式，直接用比让插件再拼一次路径省事。
 */
function dataUrlToBuffer (dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/\w+;base64,(.+)$/)
  if (!m) return null
  try {
    const buf = Buffer.from(m[1], 'base64')
    return buf.length ? buf : null
  } catch {
    return null
  }
}

// 解析器本体在 utils/payload.js —— 那边零框架依赖，单测才能脱离云崽跑
export { parsePayload }

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
