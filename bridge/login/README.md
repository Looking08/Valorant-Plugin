# 扫码登录

```
插件  ── 出二维码图、按间隔问状态、把状态翻成人话
  │
  │  REST（见下）
  ▼
网关  ── 持有会话、调用适配器、把凭证交给 provider
  │
  ├── login/qq.js       QQ 扫码（浏览器优先，纯 HTTP 兜底）
  ├── login/qqpage.js   └─ 页面式授权：真浏览器跑 m_authorize
  ├── login/browser.js  └─ 浏览器获取（puppeteer / puppeteer-core / 云崽宿主）
  ├── login/wechat.js   微信扫码（扫码 SDK，纯 HTTP）
  ├── login/wxqr.js     └─ sdk_ticket → 出码 → 轮询
  ├── login/exchange.js code/token → 掌瓦凭证
  ├── login/mock.js     假登录（仅 LOGIN_MOCK=1）
  └── 你自己的 xxx.js
```

## 为什么这件事不放在插件里

「扫码」只有两段是通用的：出二维码、轮询状态。中间那步
**「拿着 cookie 去换业务 token」跟具体站点强耦合**（掌瓦 App / 官网 web /
微信小程序三套都不一样），而它天然属于数据源，不属于聊天机器人。

所以边界划在这里：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 插件 | 出图、定时轮询、提示文案、登录后自动绑定 | 不认识 QQ，也不认识微信 |
| 网关 | 会话状态机、调用适配器、把凭证交给 provider | 不管怎么发给用户 |
| provider | `saveLogin()`：cookie → 你自己的 token 并落库 | 不管怎么拿到 cookie |

**加一个新平台 = 在 `login/` 下加一个 adapter，在这里 register 一行。插件一行都不用改。**

## 接口

全部是 GET（插件侧只发 GET，参数放 query），返回统一信封
`{ ok, data, provider, cached }`。

| 路由 | 参数 | 返回 data |
| --- | --- | --- |
| `/v1/login/adapters` | — | `{ adapters: ['qq','wx'] }` |
| `/v1/login/start` | `type` | `{ sessionId, type, qr, expireIn }` |
| `/v1/login/poll` | `session` | `{ sessionId, type, status, message, qr, profile, leftSeconds }` |
| `/v1/login/cancel` | `session` | 同上（`status: 'cancelled'`） |
| `/v1/login/commit` | `session` | `{ saved, account?, hint? }` |

`qr` 是 **data URL**（`data:image/png;base64,...`），插件直接塞进 `<img src>`，
不落盘也不外链 —— 二维码本来就不该被缓存下来。

> `sessionId` 不对外的只有内部 `state`（含 `qrsig` / `uuid` 这些能让别人
> 抢登的中间值）。`view()` 之外拿不到，日志里也别打。

### 状态机

```
waiting ──扫码──> scanned ──确认──> confirmed ──commit──> 落库
   │                  │
   ├──超时──────────> expired
   ├──上游连续空响应─> blocked      ← 被风控时的诚实结局
   └──用户取消──────> cancelled
```

`blocked` 是**刻意设计**的状态，不是错误处理补丁：上游不认这套请求时，
让用户干等到 180 秒超时是最差的选择。连续 5 次空响应就承认失败，
并告诉用户「改用 `#瓦绑定` 更稳」。

## ⚠️ 掌瓦到底怎么登录（先读这段，别白忙）

> **更正（2026-10 二次逆向）**：本文早期版本写过「掌瓦没有扫码登录、扫码这条路
> 走不通」。**这个结论是错的**，错在两处：
>
> 1. 掌瓦 App 里确实有扫码登录 —— `com.tencent.wglogin.authsuite.c#a(Activity, a)`
>    这个方法就是「用微信扫一扫登录」，走的是微信**扫码 SDK**。
> 2. 我原先找的 `qrconnect`（网站应用）要 redirect_uri 白名单，那条路确实死；
>    但扫码 SDK 根本没有 redirect_uri 这个概念。
>
> 现在 QQ / 微信两条扫码链路都已跑通出码，细节见下面两张表。

掌瓦 App 的原生登录链路是：

```
App 内点「微信/QQ 登录」
  → 拉起微信/QQ 客户端授权（SDK）
  → 拿到 openid / access_token（或微信 code）
  → POST app.mval.qq.com/go/auth/login_by_{qq,wechat} 换掌瓦凭证
  → 得到 userId / wt / ct / ctt，此后所有战绩接口都靠这套身份
```

**关键点**：换凭证这一步是掌瓦**服务端**拿它自己的 AppSecret 做的，
我们不需要 secret —— 这是整件事能成立的前提。

### 我实际扒到的东西（2026-10，可复现）

| 探测项 | 结果 |
| --- | --- |
| `val.qq.com/comm-htdocs/login/qc_redirect.html` | 存在，官网确实有 QQ/微信 web 登录 |
| `app.val.qq.com/jsapi/mval.js`（App webview 的 JSSDK） | 存在，内含真实业务接口清单 |
| 上述 JS 里的接口 | 只有 `account/getallgameroles`、`account/getgamelist`、`account/get_roles_by_game_v2`、`auth/bind_relation_list`、`user_profile/query/user` |
| 战绩类接口（match / record / battle） | **web 侧没找到**，`app.val.qq.com` 的 H5 路径全是 404 |
| `valm.qq.com`（手游《源能行动》官网） | 只有活动页，无战绩入口 |

结论：**战绩数据只在 App 私有协议后面**，web 侧只暴露「你是谁、你绑了哪个角色」。
所以扫码登录只解决「身份」，取数还得靠 `bridge/providers/` 那套。

### 那三条真正可走的路

| 路线 | 能长期取数吗 | 代价 |
| --- | --- | --- |
| **A. 扫码登录 + 掌瓦 App 接口** | 能，直到 token 过期 | 本目录这套实现（QQ 要浏览器，微信纯 HTTP） |
| **B. 抓包掌瓦 App** | 能，直到 token 过期 | 要手动抓一次，把 token/uid 填给 provider；过期要重抓 |
| **C. 第三方公开站**（黑盒等，`名称#标签` 直查） | 能，但不稳定 | 数据不全、随时可能关站；你只是它的转发器 |

A 和 B 拿到的凭证形状是一样的（Cookie + scene），可以互相替换。

## 各平台前置条件

### QQ（`qq.js` + `qqpage.js`）

**默认走浏览器**（页面式授权），不再自己追 302。

```
1  m_authorize  → openmobile.qq.com/oauth2.0/m_authorize?…&style=qr   ✅
2  页面出码      → xui.ptlogin2.qq.com 渲染 <img id="qrimg">          ✅ 264×264
3  扫码/确认      → 页面自己轮询 ptqrlogin                             ✅
4  授权回调      → 监听 auth://tauth.qq.com/#access_token=…            ✅ 不走 check_sig
5  graph/me     → access_token 换 openid                              ✅
6  login_by_qq  → 换掌瓦凭证 { user_id, wt, ct, ctt }                  ✅
7  get_main_role_raw → 角色名 + scene                                  ✅
```

**为什么必须用浏览器**（这是本次最大的认知修正）：

我第一版是纯 HTTP 手工追 `ptqrlogin → check_sig → auth://` 这条链，然后卡死在
`ptlogin4.openmobile.qq.com` —— 那台机器的 DNS 被指到 `0.0.0.1`：

```
ptlogin4.openmobile.qq.com → 0.0.0.1   （阿里 / 腾讯 / Google / 1.1.1.1 结果一致）
ptlogin4.graph.qq.com      → 0.0.0.1
ptlogin4.web.qq.com        → 0.0.0.1
```

我当时据此得出「换票前置机下线，扫码做不到」。**错在把这条路当成了唯一的路。**

实际上带 `loginty=7` + `h5sig` 的新流程压根不走 `check_sig`：
`ptqrlogin` 确认之后，页面会去 `openmobile.qq.com/oauth2.0/m_authlist`
（这个页面是**活的**，HTTP 200，标题写着「掌上无畏契约将获得以下权限」），
由它完成授权并吐出 `auth://` 回调。这条路完全在 `openmobile.qq.com` 域内。

浏览器负责跑完这段页面逻辑，我们只在旁边听三个信号：

| 信号 | 作用 |
| --- | --- |
| `page.on('request')` | 拦 `auth://…`（token 在 `#` 后面） |
| `page.on('framenavigated')` | 同上，导航不一定产生 request 事件 |
| 轮询 `location.href` | 兜底，防上面两个都没触发 |

另外还留了一层旁路：一旦发现浏览器要去访问那三台黑洞主机，就地 `abort`，
把同一个 path/query 改投到活着的 `ptlogin4.qq.com` 集群（实测它认同一套参数，
无效 sigx 会 302 到 www.qq.com）。这层是保险，正常流程用不到。

**浏览器从哪来**（`browser.js`，按优先级）：

1. `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` + `puppeteer-core`
2. `puppeteer`（自带 Chromium）
3. 云崽宿主的 `lib/puppeteer/puppeteer.js`（有 `browserInit()`）

三个都没有 → 自动降级到纯 HTTP（`QQ_MODE=http` 可强制指定），
日志会明确告诉你「可能卡在 check_sig」。

```bash
# 指定本机 Chrome（推荐，不用下 100MB 的 Chromium）
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npm i puppeteer-core
```

**UA 很关键**：必须用手机 UA，末尾带 `tencent_game_emulator`
（腾讯自己的模拟器标识）。桌面 UA 会拿到空白页，出不了码。

⚠️ 易失效点：
- `jsver`：**不要硬编码**。纯 HTTP 版会从 xlogin 页面现抓（2026-10 实测 `3ea7b82c`）。
  浏览器版不需要它。
- `MVAL_MCODE`（客户端指纹）、`QQ_APPID`（应为 `102061775`）：官方换版本要跟着改。

**拿不到 token 时的两条近路**：

```bash
# ① 手里已经有 QQ 互联 access_token（100044/10104 之外的情况）
node tools/mval-login.mjs qq --openid=<openid> --token=<access_token> --user=<QQ号> --write

# ② 只想体检整条链路，看每一步死在哪
node tools/probe-login.mjs
```

### 微信（`wechat.js` + `wxqr.js`）

**零配置，开箱能跑。** 纯 HTTP，不需要浏览器、不需要白名单、不需要 AppSecret。

```
1  get_sdk_ticket → POST app.mval.qq.com/go/auth/get_sdk_ticket  → ticket   ✅
2  签名            → sha1("appid=…&noncestr=…&sdk_ticket=…&timestamp=…")    ✅
3  出码            → GET open.weixin.qq.com/connect/sdk/qrconnect           ✅ 62KB JPEG
4  轮询            → GET long.open.weixin.qq.com/connect/l/qrconnect        ✅
                     408 未扫 / 404 已扫 / 405 带 wx_code / 402 过期
5  login_by_wechat → code 换掌瓦凭证                                        ✅
6  get_main_role_raw → 角色名 + scene                                       ✅
```

**为什么之前判断「微信扫码做不了」是错的**：

微信扫码有**两套**完全不同的东西，我原先只看到了错的那套：

| | 网站应用 `qrconnect` | 扫码 SDK `sdk/qrconnect` |
| --- | --- | --- |
| redirect_uri | **必须有，且要在开放平台备案** | **没有这个概念** |
| 门槛 | appid 归属 + 域名备案 | 一串 `sdk_ticket` + sha1 签名 |
| code 从哪来 | 回调地址（要你自己收） | 轮询接口直接吐给你 |
| 掌瓦能用吗 | ❌ 回调域是腾讯的 | ✅ |

`sdk_ticket` 本来要用 AppSecret 去换（那是服务端的事），但掌瓦自己开了个
免鉴权的 `/go/auth/get_sdk_ticket` —— 门槛也没了。这就是手机 App 里
「用微信扫一扫登录」用的那套，被我们原样复用了。

实测输出（`node tools/test-login.mjs wx`）：

```
✅ wx 出码成功（709ms）sessionId=… expireIn=180s
   二维码：data:image/jpeg;base64,/9j/4AAQ…  长度=62071
   poll#1: status=waiting msg=等待扫码
```

服务器回显的 `appname` 是「掌上无畏契约」——等于官方替我们确认了 appid 用得对。

⚠️ **appid 必须是 `wxcbb49f1f39656c2a`**。同一个 dex 里还有个
`wx5a4a8ac0fd48303a`，那是**掌上英雄联盟**的，用错一定 40029
（微信的 code 按 appid 隔离）。可用 `WX_APPID` 覆盖。

### 微信网页版（`wxweb.js`）

**默认不注册**，要跑加 `LOGIN_EXPERIMENTAL=1`。

它能零配置出真码，实测扫码、确认都能走通，但**登录的是微信网页版，
拿到的是微信自己的会话，跟无畏契约战绩没有半点关系**。
早先留着它是因为 `qq` 适配器卡在换票那步、走不到 `confirmed`，
需要有链路能跑完整状态机来调 UI —— 现在 `wx` 和 `qq` 都能跑到 `confirmed`
（`qq` 需要浏览器），它的作用只剩「验证通用代码路径」。

真机实测（2026-10）：确认后 `webwxnewloginpage` 返回的是 HTML 而不是 XML，
拿不到 `skey / pass_ticket` —— 微信对网页版登录的收紧已经不止 `ret=1203` 一种表现。

### 模拟（`mock.js`）

只在 `LOGIN_MOCK=1` 时注册，2.5s → `scanned`，4.5s → `confirmed`。
用来跑通「出图 → 状态变化 → 落库 → 自动绑定」这条交互链路，
**不会登录任何东西**。

```bash
LOGIN_MOCK=1 PORT=7820 TOKEN=valtest node bridge/server.mjs
node plugins/Valorant-Plugin/test/valtest.mjs --wait=12 '#瓦扫码登录 mock'
```

## 写一个自己的适配器

```js
// bridge/login/mysite.js
export const mysiteAdapter = {
  name: 'mysite',

  /** 出码。QR 用 data URL。state 里放轮询需要的中间值（会被服务端藏着）。 */
  async start () {
    const { qrPng, ticket } = await fetchQrFromSomewhere()
    return { qr: `data:image/png;base64,${qrPng.toString('base64')}`, state: { ticket } }
  },

  /** 轮询一次。返回 { status, message?, profile?, cookies? } */
  async poll (state) {
    const r = await pollSomewhere(state.ticket)
    if (r.scanned) return { status: 'scanned', message: '已扫描，请在手机上确认' }
    if (r.done) {
      return {
        status: 'confirmed',
        message: '登录成功',
        profile: { nickname: r.nick },        // 拿来在消息里显示「登录成谁」
        cookies: r.cookies                    // 原样交给 provider.saveLogin()
      }
    }
    return { status: 'waiting', message: '等待扫码' }
  }
}
```

然后在 `login/index.js` 里 `manager.register('mysite', mysiteAdapter)`。

### 实现 `saveLogin()`

```js
// bridge/providers/demo.js 里已有示例
async saveLogin ({ type, cookies, profile }) {
  const token = await exchange(cookies)   // ← 这一步只有你懂
  saveSomewhere(token)
  return { saved: true, account: '名称#标签' }
}
```

返回 `account` 时插件会自动帮你 `#瓦绑定`，用户扫完直接 `#瓦面板` 就能查。
不实现 `saveLogin()` 也不算错 —— 网关会如实回 `saved: false` 并附带说明。
