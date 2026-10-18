/**
 * 内置数据源：把请求原样转发到你自己的另一个服务。
 *
 * 这是「我已经有能查到数据的东西」时最短的路径 —— 比如你自己写了个
 * 掌上无畏契约的抓包服务 / Riot API 代理 / sqlite 数据落库，
 * 只要它的入参是(account, count…) 这类查询串，网关就能直接用。
 *
 * 环境变量：
 *   HTTP_UPSTREAM  必填，例如 http://127.0.0.1:9000
 *   HTTP_TOKEN     可选，转发时带上的 Authorization
 *   HTTP_TIMEOUT   可选，默认 20000ms
 *
 * ## 路径映射
 *
 * 插件请求的     →  实际转发到
 *   /v1/account   →  {UPSTREAM}/account
 *   /v1/profile   →  {UPSTREAM}/profile
 *   /v1/matches   →  {UPSTREAM}/matches
 *   /v1/match/x   →  {UPSTREAM}/match/x
 *   /v1/weapons   →  {UPSTREAM}/weapons
 *
 * ## 返回值要求
 *
 * 上游直接返回**业务数据本体**即可（网关会套一层 {ok,data}）；
 * 如果上游已经带了 ok 字段，也会被识别并使用。
 */

const UPSTREAM = String(process.env.HTTP_UPSTREAM || process.env.http_upstream || '')
const TOKEN = process.env.HTTP_TOKEN || ''
const TIMEOUT = Number(process.env.HTTP_TIMEOUT) || 20000

async function request (subPath, query = {}) {
  if (!UPSTREAM) {
    const error = new Error('未配置 HTTP_UPSTREAM，http provider 无法工作')
    error.code = 'UPSTREAM'
    throw error
  }

  const url = new URL(`${UPSTREAM.replace(/\/+$/, '')}/${subPath}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  let res
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        Accept: 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
      }
    })
  } catch (error) {
    const wrapped = new Error(
      error.name === 'TimeoutError' || error.name === 'AbortError'
        ? '上游请求超时'
        : `连不上上游：${error.message}`
    )
    wrapped.code = 'UPSTREAM'
    throw wrapped
  }

  if (res.status === 404) {
    const err = new Error('查不到这个账号 / 资源')
    err.code = 'NOT_FOUND'
    throw err
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('上游拒绝了凭证，请刷新登录态或 key')
    err.code = 'UPSTREAM_AUTH'
    throw err
  }
  if (res.status === 429) {
    const err = new Error('上游限流')
    err.code = 'RATE_LIMIT'
    throw err
  }
  if (res.status === 501) {
    const err = new Error('上游不支持该接口')
    err.code = 'NOT_SUPPORTED'
    throw err
  }
  if (!res.ok) {
    const err = new Error(`上游返回 HTTP ${res.status}`)
    err.code = 'UPSTREAM'
    throw err
  }

  let json
  try {
    json = await res.json()
  } catch {
    const err = new Error('上游返回的不是合法 JSON')
    err.code = 'UPSTREAM'
    throw err
  }

  // 上游已经带 ok 信封 → 直接信任它的语义
  if (json && typeof json === 'object' && 'ok' in json) {
    if (json.ok === false) {
      const err = new Error(json.error?.message || '上游返回失败')
      err.code = json.error?.code || 'UPSTREAM'
      throw err
    }
    return json.data
  }
  return json
}

export const httpProvider = {
  name: 'http',

  async getAccount ({ query, region }) {
    return request('account', { q: query, region })
  },

  async getProfile ({ account, region }) {
    return request('profile', { account, region })
  },

  async getMatches ({ account, region, count, mode, map }) {
    return request('matches', { account, region, count, mode, map })
  },

  async getMatch ({ matchId, account }) {
    return request(`match/${encodeURIComponent(matchId)}`, { account })
  },

  async getWeapons ({ account, region, season, count }) {
    return request('weapons', { account, region, season, count })
  },

  /**
   * 扫码凭证转发。
   *
   * 上游只需要实现 `POST {UPSTREAM}/login/save`，body 是
   * `{ type, cookies, profile }`，返回 `{ account: '名称#标签' }` 即可
   * （网关会把它带回去，插件据此提示「已登录为谁」）。
   * 上游没实现这个接口也**不算错** —— 返回 saved:false 让插件如实告知。
   */
  async saveLogin (payload) {
    if (!UPSTREAM) {
      const error = new Error('未配置 HTTP_UPSTREAM，http provider 无法工作')
      error.code = 'UPSTREAM'
      throw error
    }

    let res
    try {
      res = await fetch(`${UPSTREAM.replace(/\/+$/, '')}/login/save`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
        },
        body: JSON.stringify(payload)
      })
    } catch (error) {
      return { saved: false, hint: `凭证转发失败：${error.message}` }
    }

    if (res.status === 404 || res.status === 501) {
      return { saved: false, hint: '上游没有实现 /login/save，扫码结果没有落库' }
    }
    if (!res.ok) return { saved: false, hint: `上游返回 HTTP ${res.status}` }

    try {
      const json = await res.json()
      return { saved: true, ...(json?.data || json || {}) }
    } catch {
      return { saved: true }
    }
  }
}

export default httpProvider
