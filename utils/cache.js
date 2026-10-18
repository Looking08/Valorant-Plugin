/**
 * TTL 内存缓存。
 *
 * 战绩类数据短时间内重复查询很常见（群里几个人一起查同一个人），
 * 加了这层可以明显减少网关压力。进程重启即失效 —— 这类数据本来也不需要持久化。
 */
const store = new Map()
/** 正在飞行中的请求：同 key 并发只发一次 */
const inflight = new Map()

/**
 * 取缓存，没有就调用 fn 并把结果写进去
 * @param {string} key
 * @param {number} ttl 秒
 * @param {() => Promise<any>} fn
 */
export async function remember (key, ttl, fn) {
  const hit = store.get(key)
  if (hit && Date.now() < hit.expire) return hit.value

  // 同 key 并发合流：第一个请求的结果大家共享，避免雪崩打爆网关
  if (inflight.has(key)) return inflight.get(key)

  const task = (async () => {
    try {
      const value = await fn()
      store.set(key, { value, expire: Date.now() + ttl * 1000 })
      return value
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

export function forget (key) {
  store.delete(key)
}

export function clearAll () {
  store.clear()
}

/** 定期清理过期项，避免长期运行内存只涨不降 */
export function startGc (intervalSec = 600) {
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, hit] of store) {
      if (now >= hit.expire) store.delete(key)
    }
  }, intervalSec * 1000)
  timer.unref?.()
  return timer
}
