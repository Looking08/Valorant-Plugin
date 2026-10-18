# 扫码登录

```
插件  ── 出二维码图、按间隔问状态、把状态翻成人话
  │
  │  REST（见下）
  ▼
网关  ── 持有会话、调用适配器、把凭证交给 provider
  │
  ├── login/qq.js       QQ 互联 ptlogin2
  ├── login/wechat.js   微信开放平台 qrconnect
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

> **更新（后续已解决）**：掌瓦的战绩接口已经靠抓包定位并打通 ——
> `app.mval.qq.com/go/codev/career/*`，凭证是 Cookie + `scene`。
> 走这条路的实际方案在 [../providers/mateapp.md](../providers/mateapp.md)，
> **不需要扫码**。下面这段留作「为什么扫码对掌瓦不成立」的记录。

「扫码登录 → 一直能查战绩」这个想法听起来顺，但它有个前提不成立：

**掌瓦（掌上无畏契约）里没有「扫码登录」这个动作。**

掌瓦是 App，它的登录链路是：

```
App 内点「微信/QQ 登录」
  → 拉起微信/QQ 客户端授权（SDK，不是扫码）
  → 拿到 openid / access_token（腾讯游戏通行证）
  → 用它去换「游戏角色」（api.val.qq.com/go/account/get_roles_by_game_v2）
  → 得到 uid + 角色 id，此后所有战绩接口都靠这套身份
```

「扫码」只存在于**第三方网站**接入 QQ/微信登录的场景（`ptlogin2` / `qrconnect`），
掌瓦自己不用它。而且就算我们能模拟扫码，拿到的也只是一个 `code`，
换 token 需要**掌瓦自己的 app secret** —— 那是腾讯手里的东西。

### 我实际扒到的东西（2026-10，可复现）

| 探测项 | 结果 |
| --- | --- |
| `val.qq.com/comm-htdocs/login/qc_redirect.html` | 存在，官网确实有 QQ/微信 web 登录 |
| `app.val.qq.com/jsapi/mval.js`（App webview 的 JSSDK） | 存在，内含真实业务接口清单 |
| 上述 JS 里的接口 | 只有 `account/getallgameroles`、`account/getgamelist`、`account/get_roles_by_game_v2`、`auth/bind_relation_list`、`user_profile/query/user` |
| 战绩类接口（match / record / battle） | **web 侧没找到**，`app.val.qq.com` 的 H5 路径全是 404 |
| `valm.qq.com`（手游《源能行动》官网） | 只有活动页，无战绩入口 |

结论：**战绩数据只在 App 私有协议后面**，web 侧只暴露「你是谁、你绑了哪个角色」。

### 那三条真正可走的路

| 路线 | 能长期取数吗 | 代价 |
| --- | --- | --- |
| **A. 抓包掌瓦 App** | 能，直到 token 过期 | 要手动抓一次登录请求，把 token/uid 填给 provider；过期要重抓（或自己实现刷新） |
| **B. 第三方公开站**（黑盒等，`名称#标签` 直查） | 能，但不稳定 | 数据不全、随时可能关站或加验证；你的插件只是它的转发器 |
| **C. 官网 web 登录 + 账号接口** | 只能拿到「绑了哪个角色」，拿不到战绩 | 需要攻 QQ web 登录的风控（见下一节），收益还很低 |

所以本插件的默认姿势仍然是：**网关 + 你自己抓包来的 provider**，
扫码只是「证明链路通」的调试工具，不是数据来源。

## 各平台前置条件

### QQ（`qq.js`）

不需要任何配置，但有实测结论必须先说清楚：

```
第 1 步 xlogin   → 拿 pt_login_sig          ✅ 稳定
第 2 步 ptqrshow → 拿到真二维码 PNG         ✅ 稳定
第 3 步 ptqrlogin→ 轮询扫码结果              ⚠️ 经常 HTTP 200 + 空 body
```

第 3 步的空响应来自 TAPISIX 前置网关，特征是 `Server: TAPISIX`、body 长度 0。
已试过并**无效**的手段：换 `ptredirect=0/1`、补全 `xlogin` 的 cookie jar、
完整 Chrome UA + Referer、不同 TLS 客户端。判断是**按 TLS 指纹静默丢弃**。

两条可行替代路径（都需要你动一下手）：

1. **浏览器方案** —— 用真实浏览器（playwright/puppeteer）打开
   `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?...` 让它在真 TLS 栈里跑，
   再把 `ptqrlogin` 的响应拦下来喂回本服务；
2. **粘贴真实请求头** —— 从浏览器 F12 里拷一份 `ptqrlogin` 请求的
   Cookie / UA / Referer，填进 `qq.js` 顶部常量。

所以本插件对 QQ 扫码的态度是：**能出码，但别指望它稳**。
想要 100% 可用的绑定路径，仍然是 `#瓦绑定 名称#标签`。

### 微信（`wechat.js`）

必须有一个**已通过审核的微信开放平台「网站应用」**：

```bash
WX_APPID=wx....            # 开放平台 → 网站应用
WX_SECRET=....             # 换 access_token 用
WX_REDIRECT=https://your.domain/...   # 授权回调域必须与备案域名一致
```

没有任何一项时适配器直接返回 `NOT_CONFIGURED`，**不会让用户白扫一张注定失败的码**。

注意：`poll` 拿到 `wx_errcode=405` 时只说明「用户确认了」，微信给的还是
`code`，得拿 `AppSecret` 去换 `access_token` / `openid` —— 这一步放在
provider 的 `saveLogin()` 里做，因为「换到什么」因数据源而异。

### 微信网页版（`wxweb.js`）

**默认不注册**，要跑加 `LOGIN_EXPERIMENTAL=1`。

它能零配置出真码，实测扫码、确认都能走通，但**登录的是微信网页版，
拿到的是微信自己的会话，跟无畏契约战绩没有半点关系**。
留着它只是因为 `qq` 适配器卡在轮询那步、走不到 `confirmed`，
需要一条能跑完整状态机的链路来调 UI。

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
