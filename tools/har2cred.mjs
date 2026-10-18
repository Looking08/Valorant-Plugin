#!/usr/bin/env node
/**
 * 把抓包得到的 HAR 变成一行「可直接发给机器人」的登录态。
 *
 * ## 为什么需要它
 *
 * 掌瓦的登录态是 cookie + 两个 scene（列表用一个、详情用另一个）。
 * 让人对着 30MB 的 HAR 手抄这三个值，出错概率比抓包本身还高。
 * 这个脚本把「找哪条请求、抠哪几个字段」固化下来。
 *
 * ## 用法
 *
 *   # 只打印，自己复制去发 #瓦导入
 *   node tools/har2cred.mjs ~/Downloads/xxx.har
 *
 *   # 云崽跑在 docker 里（推荐）：自动 cp 进容器、在容器内推给容器内的网关
 *   node tools/har2cred.mjs xxx.har --docker --user=123456 --token=valtest
 *
 *   # 云崽直接跑在宿主机
 *   node tools/har2cred.mjs xxx.har --push --user=123456 \
 *     --gateway=http://127.0.0.1:7820 --token=valtest
 *
 *   # 只看三个字段，不拼成一行
 *   node tools/har2cred.mjs xxx.har --json
 *
 * ⚠️ 为什么要有 `--docker`：TRSS 一键镜像是 bridge 网络，网关只听容器自己的
 *    127.0.0.1:7820，宿主机 curl 过去是 refused。所以宿主机跑 `--push` 必失败。
 *
 * ## 它是怎么挑的
 *
 *   1. 只看 `app.mval.qq.com` 的请求（别的域名的 cookie 没用）
 *   2. cookie 取 `career/record/list` 那条的 `Cookie` 头；没有就退回任意 career 请求
 *   3. scene 取 `career/record/list` 请求体里的 `scene`
 *   4. sceneDetail 取 `career/record/player/rounds` 请求体里的 `scene`，
 *      没有就退成和 scene 一样（只影响单局详情页，不影响列表）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOST = 'app.mval.qq.com'

/** docker 场景下的默认值（TRSS 的一键镜像基本都是这个布局） */
const DOCKER_DEFAULTS = {
  container: process.env.DOCKER_CONTAINER || 'TRSS_AllBot',
  pluginDir: process.env.DOCKER_PLUGIN_DIR || '/root/TRSS_AllBot/TRSS-Yunzai/plugins/Valorant-Plugin'
}

/** 命令行参数 */
function argsOf (argv) {
  const flags = new Map()
  const rest = []
  for (const item of argv) {
    if (item.startsWith('--')) {
      const [key, value] = item.slice(2).split('=')
      flags.set(key, value === undefined ? true : value)
    } else {
      rest.push(item)
    }
  }
  return { flags, rest }
}

function headerOf (entry, name) {
  const list = entry?.request?.headers || []
  const hit = list.find(h => String(h.name).toLowerCase() === name.toLowerCase())
  return hit ? String(hit.value) : ''
}

/** HAR 里 cookie 也可能在 request.cookies[]，两处都看 */
function cookieOf (entry) {
  const fromHeader = headerOf(entry, 'cookie')
  if (fromHeader) return fromHeader

  const cookies = entry?.request?.cookies || []
  if (!cookies.length) return ''
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function bodyOf (entry) {
  const text = entry?.request?.postData?.text || ''
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function pathOf (entry) {
  try {
    return new URL(entry.request.url).pathname
  } catch {
    return ''
  }
}

export function parseHar (har) {
  const entries = har?.log?.entries || []
  const mval = entries.filter(e => {
    try {
      return new URL(e.request.url).host === HOST
    } catch {
      return false
    }
  })

  if (!mval.length) {
    throw new Error(`这个 HAR 里没有 ${HOST} 的请求。抓包时要打开掌瓦的「战绩」页。`)
  }

  /** 找某条路径的第一条请求 */
  const find = suffix => mval.find(e => pathOf(e).endsWith(suffix))

  // cookie：优先 career/record/list，它一定带完整登录态
  const cookieEntry = find('/career/record/list')
    || find('/career/seasonoverview')
    || mval.find(e => pathOf(e).includes('/career/'))
    || mval[0]

  let cookie = cookieOf(cookieEntry)

  // 有些抓包工具把 cookie 放在 request.headers 的数组里但名字大小写不一，
  // 上面已经兼容；这里再兜一次「只有 cookies[] 的情况」并去掉换行
  cookie = String(cookie || '').replace(/\r?\n\s*/g, ' ').replace(/\s*;\s*/g, '; ').trim()

  const listBody = bodyOf(find('/career/record/list'))
  const roundsBody = bodyOf(find('/career/record/player/rounds'))

  const scene = String(listBody?.scene || '')
  const sceneDetail = String(roundsBody?.scene || scene)

  const uid = (cookie.match(/(?:^|;\s*)userId=([^;]+)/i) || [])[1] || ''

  return {
    cookie,
    scene,
    sceneDetail,
    uid: uid ? decodeURIComponent(uid) : '',
    stats: {
      entries: entries.length,
      mval: mval.length,
      hasCookie: !!cookie,
      hasScene: !!scene,
      hasSceneDetail: !!roundsBody?.scene
    }
  }
}

/** 拼成 `cookie|scene|sceneDetail` —— 这就是 `#瓦导入` 要吃的那一行 */
export function toLine (cred) {
  return [cred.cookie, cred.scene, cred.sceneDetail].join('|')
}

async function push (cred, { user, gateway, token }) {
  if (!user) throw new Error('--push 需要 --user=<QQ号>（网关按它存凭证）')
  if (!gateway) throw new Error('--push 需要 --gateway=http://127.0.0.1:7820')

  const res = await fetch(`${gateway.replace(/\/$/, '')}/v1/creds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      user,
      cookie: cred.cookie,
      scene: cred.scene,
      sceneDetail: cred.sceneDetail
    })
  })

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}

  if (!res.ok || !json?.ok) {
    throw new Error(`网关拒绝了：${json?.error?.message || text.slice(0, 300)}`)
  }
  return json.data
}

/**
 * 用云崽跑在 docker 里的场景：把 HAR 丢进去，让容器内的脚本推给容器内的网关。
 *
 * 为什么要这一步：TRSS 的一键镜像是 bridge 网络，网关只听容器自己的
 * 127.0.0.1:7820，宿主机 `curl 127.0.0.1:7820` 是连不上的。
 * 所以宿主机跑 --push 会失败，必须进去跑 —— 这里把 cp / exec / 清理 串成一条命令。
 */
function pushViaDocker ({ harPath, container, user, token, pluginDir }) {
  const stamp = Date.now()
  const remote = `/tmp/val-har-${stamp}.har`

  console.log(`→ docker cp 到 ${container}:${remote}（${(fs.statSync(harPath).size / 1024 / 1024).toFixed(1)}MB）`)
  execFileSync('docker', ['cp', harPath, `${container}:${remote}`], { stdio: 'inherit' })

  try {
    const args = [
      'exec', container, 'node', `${pluginDir}/tools/har2cred.mjs`, remote,
      '--push', `--user=${user}`, '--gateway=http://127.0.0.1:7820'
    ]
    if (token) args.push(`--token=${token}`)
    execFileSync('docker', args, { stdio: 'inherit' })
  } finally {
    // 33MB 的 HAR 留在容器 /tmp 里没意义，删掉
    try {
      execFileSync('docker', ['exec', container, 'rm', '-f', remote], { stdio: 'ignore' })
    } catch {}
  }
}

/* ---------------- CLI ---------------- */

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const { flags, rest } = argsOf(process.argv.slice(2))
  const file = rest[0]

  if (!file) {
    console.error([
      '用法：node tools/har2cred.mjs <抓包.har> [选项]',
      '',
      '  （不带选项）  打印一行 #瓦导入 ...，复制去群里发',
      '  --json       只打印三个字段，不拼成一行',
      '  --push       推给同机的网关（网关和本机在同一环境时用）',
      '  --docker     云崽跑在 docker 里时用：自动 cp 进容器、在容器内推送',
      '',
      '  公共参数：--user=QQ --token=网关令牌',
      '  --gateway=URL        --push 用，默认 http://127.0.0.1:7820',
      '  --docker=容器名       默认 TRSS_AllBot',
      '  --plugin=容器内路径   默认 /root/TRSS_AllBot/TRSS-Yunzai/plugins/Valorant-Plugin',
      '',
      '例：',
      '  node tools/har2cred.mjs 掌瓦.har --docker --user=123456 --token=valtest'
    ].join('\n'))
    process.exit(1)
  }

  let har
  try {
    har = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`读不了这个 HAR：${error.message}`)
    process.exit(1)
  }

  let cred
  try {
    cred = parseHar(har)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  if (!cred.stats.hasCookie || !cred.stats.hasScene) {
    console.error([
      '没抠全：',
      `  cookie ${cred.stats.hasCookie ? '✅' : '❌ 没找到带 Cookie 的请求'}`,
      `  scene  ${cred.stats.hasScene ? '✅' : '❌ 请求体里没有 scene'}`,
      '',
      '多半是抓包时没进「战绩」页，或者抓包工具没记录请求体（要开「记录 POST body」）。'
    ].join('\n'))
    process.exit(1)
  }

  if (flags.has('json')) {
    console.log(JSON.stringify({
      cookie: cred.cookie,
      scene: cred.scene,
      sceneDetail: cred.sceneDetail,
      uid: cred.uid
    }, null, 2))
    process.exit(0)
  }

  // --docker 那段会在容器里再跑一次本脚本，那一次会打印这一行；
  // 这里再打一遍就重复了，所以只在「本机直接出结果」时打印。
  if (!flags.has('docker')) {
    console.log('')
    console.log(`登录态已就绪（UID ${cred.uid || '未知'}，共 ${cred.stats.mval} 条掌瓦请求）`)
    if (!cred.stats.hasSceneDetail) {
      console.log('注：没找到详情页专用 scene，已用列表那个顶上（详情页可能查不出来）')
    }
    console.log('')
    console.log('发给机器人（或直接复制这一行）：')
    console.log('')
    console.log(`#瓦导入 ${toLine(cred)}`)
    console.log('')
  }

  if (flags.has('docker')) {
    const name = flags.get('docker')
    try {
      pushViaDocker({
        harPath: path.resolve(file),
        container: typeof name === 'string' ? name : DOCKER_DEFAULTS.container,
        user: flags.get('user') || process.env.CRED_USER,
        token: flags.get('token') || process.env.GATEWAY_TOKEN || process.env.TOKEN || '',
        pluginDir: flags.get('plugin') || DOCKER_DEFAULTS.pluginDir
      })
    } catch (error) {
      console.error(`❌ 推送失败：${error.message}`)
      if (/Cannot connect|No such container/.test(String(error.message))) {
        console.error(`   容器名不对？当前默认 ${DOCKER_DEFAULTS.container}，用 --docker=你的容器名 指定`)
      }
      process.exit(1)
    }
  } else if (flags.has('push')) {
    try {
      const saved = await push(cred, {
        user: flags.get('user') || process.env.CRED_USER,
        gateway: flags.get('gateway') || process.env.GATEWAY_URL || 'http://127.0.0.1:7820',
        token: flags.get('token') || process.env.GATEWAY_TOKEN || process.env.TOKEN || ''
      })
      console.log(`✅ 已推给网关：user=${saved?.user} 角色=${saved?.role?.name || '未知'}（已验证可用）`)
    } catch (error) {
      console.error(`❌ 推送失败：${error.message}`)
      console.error('   如果云崽跑在 docker 里，宿主连不上容器网关 —— 改用 --docker')
      process.exit(1)
    }
  }
}
