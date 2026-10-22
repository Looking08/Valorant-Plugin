/**
 * 浏览器获取 —— QQ 扫码要用真浏览器跑页面。
 *
 * ## 为什么非得用浏览器
 *
 * QQ 的扫码授权最后一跳是「`check_sig` → 302 → `auth://tauth.qq.com/#access_token=…`」。
 * 纯 HTTP 手工追这条 302 链时，只要**任意一跳**的主机解析不出来，整条链就断，
 * 而我们对此无能为力（`ptlogin4.openmobile.qq.com` 实测被 DNS 指到 0.0.0.1）。
 *
 * 让浏览器去跑就不一样了：页面里的 JS 自己会按它知道的规则完成跳转，
 * 我们只需要在旁边「听」——监听 `auth://` 这个非 http 协议的导航请求，
 * 从 URL fragment 里把 token 掏出来。少一层自己实现跳转逻辑，就少一处会断的地方。
 *
 * ## 三种来源，按优先级试
 *
 *   1. `PUPPETEER_EXECUTABLE_PATH` + `puppeteer-core`（部署者自己装了 Chrome）
 *   2. `puppeteer`（自带 Chromium）
 *   3. 云崽宿主的 `lib/puppeteer/puppeteer.js`（只有 `browserInit()`，够用）
 *
 * 都没有就返回 null，让调用方降级到纯 HTTP 方案，而不是抛异常。
 *
 * ## Docker / 容器里的坑（2026-10 补）
 *
 * `puppeteer` 这个包**装了不等于能用**：它默认去 `~/.cache/puppeteer` 找自己
 * 下载的那份 Chromium，而 `npm i puppeteer` 在有 `PUPPETEER_SKIP_DOWNLOAD=1`
 * 或者镜像源被墙时会跳过下载 —— 于是 `launch()` 报「Could not find Chrome」。
 *
 * 但容器/发行版**往往已经装了系统 chromium**（Arch 的 `chromium` 包、Debian 的
 * `chromium`、官方的 `google-chrome`）。所以这里加了一层**系统浏览器探测**：
 * 找到就直接拿它的路径喂给 puppeteer，省下 100+MB 的下载，也避免重复装。
 *
 * 覆盖方式：`PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`，或 `LOGIN_BROWSER=off` 禁用。
 */

import { existsSync } from 'node:fs'

/** 常见发行版 / 系统里 chromium 的落点，按命中概率排 */
const SYSTEM_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  // Linux
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/sbin/chromium',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
]

/** 找一个真实存在的浏览器可执行文件；找不到返回 '' */
function detectExecutable () {
  for (const candidate of SYSTEM_CANDIDATES) {
    if (!candidate) continue
    try { if (existsSync(candidate)) return candidate } catch {}
  }
  return ''
}

const LAUNCH_ARGS = [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--no-zygote',
  '--disable-blink-features=AutomationControlled'
]

/** 浏览器实例复用：每次扫码开一个新浏览器太慢（1~2s），也不好回收 */
let shared = { browser: null, at: 0, launching: null, source: '' }
const IDLE_MS = Number(process.env.LOGIN_BROWSER_IDLE) || 5 * 60 * 1000

/** 依次尝试各种来源，先看部署者给没给可执行文件 */
async function resolveLauncher () {
  if (String(process.env.LOGIN_BROWSER || '').toLowerCase() === 'off') return null

  // 1) 有可执行文件就走它 —— 容器里 99% 命中这条
  const exe = detectExecutable()
  if (exe) {
    const withExe = (core, label) => ({
      source: `${label}(${exe})`,
      launch: () => core.launch({ executablePath: exe, headless: 'new', args: LAUNCH_ARGS, timeout: 60000 })
    })

    // 1a) puppeteer-core：不绑定版本，最省事
    try {
      const core = (await import('puppeteer-core')).default
      return withExe(core, 'puppeteer-core')
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }

    // 1b) puppeteer 整包也接受 executablePath，用它覆盖自带浏览器
    try {
      const pkg = (await import('puppeteer')).default
      return withExe(pkg, 'puppeteer')
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }

  // 2) 没有系统浏览器：赌 puppeteer 自带的那份已经下载好了
  try {
    const pkg = (await import('puppeteer')).default
    let bundled = ''
    try { bundled = pkg.executablePath() } catch {}
    const usable = bundled && existsSync(bundled)
    return {
      source: usable ? 'puppeteer(自带)' : 'puppeteer',
      launch: () => pkg.launch({ headless: 'new', args: LAUNCH_ARGS, timeout: 60000 })
    }
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }

  // 云崽宿主：lib/puppeteer/puppeteer.js 暴露 browserInit()
  // ⚠️ 这里比 utils/render.js 深一层（bridge/login/），所以要四个 `../`
  //    推演：bridge/login → bridge → Valorant-Plugin → plugins → <云崽根>/lib/…
  try {
    const host = (await import('../../../../lib/puppeteer/puppeteer.js')).default
    if (host?.browserInit) {
      return {
        source: 'yunzai',
        // 宿主的 browserInit() 已经处理了「连远程还是本地起」，直接用
        launch: async () => host.browserInit()
      }
    }
  } catch {}

  return null
}

/**
 * 拿一个可用的浏览器。拿不到返回 null（调用方降级）。
 * @returns {Promise<{browser: object, source: string}|null>}
 */
export async function acquireBrowser () {
  if (shared.browser && shared.browser.connected !== false) return { browser: shared.browser, source: shared.source }
  if (shared.launching) {
    const browser = await shared.launching
    return browser ? { browser, source: shared.source } : null
  }

  shared.launching = (async () => {
    const launcher = await resolveLauncher()
    if (!launcher) {
      console.warn('[login] 没找到可用的浏览器：QQ 扫码将降级为纯 HTTP（可能卡在 check_sig）')
      return null
    }
    try {
      const browser = await launcher.launch()
      shared.browser = browser
      shared.source = launcher.source
      shared.at = Date.now()
      console.log(`[login] 浏览器就绪（${launcher.source}）`)
      return browser
    } catch (error) {
      console.warn(`[login] 浏览器启动失败（${launcher.source}）：${error.message}`)
      return null
    } finally {
      shared.launching = null
    }
  })()

  const browser = await shared.launching
  return browser ? { browser, source: shared.source } : null
}

/** 开一个页面上下文。用完自己 close(page)，浏览器留着复用。 */
export async function openPage ({ userAgent, viewport } = {}) {
  const got = await acquireBrowser()
  if (!got) return null

  const page = await got.browser.newPage()
  try {
    if (userAgent) await page.setUserAgent(userAgent)
    if (viewport) await page.setViewport(viewport)
    // 手机 UA 下 QQ 才给二维码版式；顺带把 webdriver 标记抹掉
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })
  } catch (error) {
    await page.close().catch(() => {})
    throw error
  }
  return page
}

/** 空闲回收：没人用的时候就关掉，别在用户机器上留个常驻 Chromium */
export function touchBrowser () {
  shared.at = Date.now()
}

const janitor = setInterval(async () => {
  if (!shared.browser) return
  if (Date.now() - shared.at < IDLE_MS) return
  const browser = shared.browser
  shared = { browser: null, at: 0, launching: null, source: '' }
  try { await browser.close() } catch {}
}, 60 * 1000)
janitor.unref?.()

export default { acquireBrowser, openPage, touchBrowser }
