/**
 * 配置访问入口。
 *
 * 插件各处统一从这里取配置，不用关心 Config 的「模板 ← 用户」合并语义。
 * ⚠️ 每个 getter 都做了类型兜底：用户手写的配置是任意形状，
 *    类型不对时退回默认值，别让它炸在查询路径上。
 */
import { Config } from '#components'

export function all () {
  return Config.get('config') || {}
}

/** 战绩网关（自建转发服务）配置 */
export function gateway () {
  const c = all()
  return {
    url: String(c.gateway?.url || '').replace(/\/+$/, ''),
    token: String(c.gateway?.token || ''),
    timeout: Number(c.gateway?.timeout) || 20000
  }
}

/** 静态游戏数据（valorant-api.com）配置 */
export function staticApi () {
  const c = all()
  return {
    url: String(c.static?.url || 'https://valorant-api.com').replace(/\/+$/, ''),
    language: String(c.static?.language || 'zh-CN'),
    proxy: String(c.static?.proxy || ''),
    timeout: Number(c.static?.timeout) || 20000,
    ttl: Number(c.static?.ttl) || 43200
  }
}

/** 展示类配置 */
export function display () {
  const c = all()
  return {
    matchesMax: Math.min(Number(c.display?.matchesMax) || 30, 50),
    matchesDefault: Number(c.display?.matchesDefault) || 10,
    weaponsMax: Math.min(Number(c.display?.weaponsMax) || 40, 60),
    weaponsDefault: Number(c.display?.weaponsDefault) || 20,
    agentsDefault: Number(c.display?.agentsDefault) || 5,
    assetCache: c.display?.assetCache !== false
  }
}

/** 指令配置 */
export function command () {
  const c = all()
  return {
    prefix: String(c.command?.prefix || '#瓦'),
    alias: Array.isArray(c.command?.alias) ? c.command.alias : []
  }
}

/**
 * 扫码登录配置。
 *
 * `pollSeconds` 是「出码后自动帮你盯多久」：值太大会让机器人白白挂着定时器，
 * 太小用户还没掏出手机就停了。150s 大致等于二维码本身的有效期。
 */
export function login () {
  const c = all()
  const l = c.login || {}
  // ⚠️ 别写成 `Number(x) ?? 默认值`：Number(undefined) 是 NaN，而 ?? 只兜 null/undefined，
  //    NaN 会一路传下去，最后变成「定时器 0 秒」这种诡异行为。
  const rawSeconds = Number(l.pollSeconds)
  const pollSeconds = Number.isFinite(rawSeconds) ? Math.min(Math.max(rawSeconds, 0), 300) : 150

  return {
    type: String(l.type || 'qq').toLowerCase(),
    pollSeconds,
    pollInterval: Math.min(Math.max(Number(l.pollInterval) || 2, 1), 10),
    // 登录成功后是否自动把账号绑到当前 QQ 名下
    autoBind: l.autoBind !== false
  }
}

export default all
