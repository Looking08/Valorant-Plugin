/**
 * 粘贴内容解析 —— 纯字符串处理，**不依赖任何框架全局**。
 *
 * 单独放一个文件的原因：这段逻辑分支多、全靠字符串匹配，改一行就可能悄悄坏掉，
 * 必须有离线单测（`test/parse-payload.mjs`）。放在 `apps/*.js` 里的话，
 * import 会连带 `#components` → 框架的 puppeteer，脱离云崽就跑不起来，
 * 单测也就只能在云崽内部跑。这里保持零依赖，`node test/parse-payload.mjs` 在哪都能跑。
 */

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
