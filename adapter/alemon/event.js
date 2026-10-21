/**
 * 把 alemonjs 的事件对象**伪装成云崽的 e**，这样 `apps/` 和 `utils/` 里的代码不用改。
 *
 * 云崽那边实际用到的字段只有五个（全仓库 grep 过）：
 *   `e.msg`     消息原文           ← event.MessageText
 *   `e.reply()` 回复               ← useMessage().send({ format })
 *   `e.user_id` 发送者 id           ← event.UserId
 *   `e.at`      被 @ 的人的 id      ← useMention().findOne()
 *   `e.atme`    是否 @ 了机器人      ← event.IsAtMe
 *
 * 其余字段（group_id / isGroup / self_id / nickname）是顺手补的，便于以后扩展。
 *
 * ⚠️ `useXxx()` 走的是 AsyncLocalStorage，**只能在 handler 的同步调用链里取**，
 *    所以 `createYunzaiEvent()` 必须在响应函数内部 `await`（不能在模块顶层缓存）。
 */
import { useMessage, useEvent, useMention, Format } from 'alemonjs'

/** 单条消息的长度上限：QQ 侧大约 4~5k 字节会失败，取个保守值 */
const MAX_TEXT = 3000

/** 把内容塞进 Format；认得 Buffer（图片）、字符串、数组 */
function buildFormat (content) {
  const format = Format.create()

  if (Buffer.isBuffer(content)) {
    format.addImage(content)
    return format
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (Buffer.isBuffer(item)) format.addImage(item)
      else if (item != null) format.addText(String(item))
    }
    return format
  }

  if (content && typeof content === 'object') {
    // 云崽里偶尔会传 { type: 'image', file: ... } 这类 segment，这里只兜住常见的
    if (content.file || content.src || content.url) {
      format.addImage(String(content.file || content.src || content.url))
      return format
    }
    format.addText(String(content.text ?? content.msg ?? ''))
    return format
  }

  format.addText(String(content ?? ''))
  return format
}

/**
 * 造一个云崽风格的事件对象。
 * @returns {Promise<object>} e
 */
export async function createYunzaiEvent () {
  const [message] = useMessage()
  const [eventResult] = useEvent()
  const [mention] = useMention()

  const ev = eventResult?.current || {}

  // @ 的人：useMention 默认会过滤掉机器人，所以「只 @ 了机器人」时拿到空 —— 和云崽的
  // `e.at && !e.atme` 行为一致。拿不到也别炸，@ 只是可选功能。
  let atUser = null
  try {
    const res = await mention.findOne()
    if (res?.count && res?.data) atUser = res.data
  } catch {
    atUser = null
  }

  /** 回复。云崽的 e.reply 返回 Promise，这里保持一致 */
  async function reply (content, _options = {}) {
    // 空内容不值得发一条
    if (content == null || content === '') return false

    if (typeof content === 'string' && content.length > MAX_TEXT) {
      // 长文本拆成多条，避免平台截断或直接失败
      const chunks = content.match(new RegExp(`[\\s\\S]{1,${MAX_TEXT}}`, 'g')) || [content]
      for (const chunk of chunks) {
        await message.send({ format: buildFormat(chunk) })
      }
      return true
    }

    await message.send({ format: buildFormat(content) })
    return true
  }

  return {
    // —— 云崽同名同义 ——
    msg: String(ev.MessageText ?? ''),
    user_id: String(ev.UserId ?? ''),
    at: atUser?.UserId ? String(atUser.UserId) : '',
    atme: !!ev.IsAtMe,
    reply,

    // —— 顺手补的扩展 ——
    group_id: String(ev.GuildId ?? ev.SpaceId ?? ''),
    channel_id: String(ev.ChannelId ?? ''),
    isGroup: !ev.IsPrivate,
    isPrivate: !!ev.IsPrivate,
    self_id: String(ev.BotId ?? ''),
    nickname: String(ev.UserName ?? ''),
    platform: String(ev.Platform ?? ''),
    /** 主人权限（`#瓦更新` 这类指令的 rule 里写了 permission: 'master'） */
    isMaster: !!ev.IsMaster,
    message_id: String(ev.MessageId ?? ''),

    /** 原始事件，写新功能时可以直接用 */
    _raw: ev
  }
}
