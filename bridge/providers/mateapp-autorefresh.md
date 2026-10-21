---

## 补充（2026-10-19 实测）：access_token 可以自己续

> **2026-10-21 更正：下面的「续命」只能续上层 access_token，续不到底层票据。**
> 底层 web ticket 是**硬 3 天**（实测 `validFrom`→`validTo` = 259200 秒整），
> 到点必失效，没有缓冲。真能续它的 `refresh_client_ticket` 要 `ct` + App 签名，拿不到。
> 所以「一次抓包能用多久」的答案是 **3 天**，不是「挺久」。

之前说「登录态会过期就得重抓」说得太绝对了。本机拿真实登录态打了一遍，**票据没彻底失效之前是能续的**：

```
POST /go/auth/refresh_third_token?source_game_zone=codev&game_zone=codev
body: { type: "wx", uuid: "<userId>", openid: "<openid>", source_game_zone, game_zone }
→ data.access_token（新的，time_interval=3600）
```

要点：

- **不需要 App 签名。** `type / uuid / openid` 三个值全都能从登录态自己的 cookie 里读出来
  （`appid` 以 `wx` 开头 → `type=wx`；`userId` 就是 uuid）。真正需要 App 签名的是
  拿 `ct`（448 字符那张）去换的下游票据，这一步绕开它了。
- **服务端仍要看你 cookie 里的登录票据。** 不带 cookie → `cookie userid empty`；
  残缺 cookie（比如只留 userId + tid）→ `登录票据过期` / result=1002。
  所以这是「续命」不是「无中生有」——彻底失效后依然得重抓一次。
- 换出来的新 token 配上**原来的 scene** 一样查得动数据（实测赛季概览返回 9 个赛季）。

### 代码里怎么落的

| 位置 | 作用 |
| --- | --- |
| `freshCookie(config)` | 每次发业务请求前，超过 30 分钟就续一次（token 官方给 3600 秒，留一半余量） |
| `refreshAccessToken(config)` | 具体那一发 HTTP；拿到就拼回 cookie，**拿不到就原样返回旧 cookie**，绝不把还能用的登录态改坏 |
| `touchCredential(user)` | 给网关的后台任务用，多账号每人一份各自续 |
| `server.mjs startKeepAlive()` | 每 25 分钟跑一轮，`KEEP_ALIVE=0` 关闭 |

为什么还要后台定时：懒加载式续期只在「有人查」时生效，安静挂两周照样凉。

### 二分出来的 cookie 必填项（结论）

| 试过的组合 | 结果 |
| --- | --- |
| 完整 cookie | ✓ 拿到新 token |
| 完整 cookie 但 access_token 置空 | ✓ 照样给新的 —— 这步压根不看你旧 token |
| 只 userId / userId+appid+acctype / +openid+clientType | ✗ result=1002 登录态失效 |
| userId + tid | △ result=0 但 data 为空，提示「登录票据过期」 |

也就是说服务端认的是**整套登录票据**，不是一个两个字段能糊弄过去的。

---

唯一确定能落地的真·扫码方案，仍然是在服务器上跑一个安卓实例（redroid / 模拟器）装真掌瓦，
让它自己走完登录、再从它的流量里取凭证 —— 本质是「把抓包自动化」，不是破解登录协议。
本机（Intel Mac + Docker Desktop）跑不了 redroid：boot 到的是 linuxkit 内核，
没有 `/dev/binder` 也没有 binderfs，且 docker pull 走不通；
Android Studio 只装了 platform-tools，emulator 与系统镜像都要现下 ~2GB，
而机器是 2 核 8G、负载常年两位数，跑起来基本不能用。所以没往那边走了。

---

## 补充（2026-10-21 实测）：还有一条 `bind_relation_list`，能拿到真实账号

逆向 2.9.0 APK 时把 `/go/auth/*` 的接口表扒出来了（14 条），其中这条最好用：

```
POST /go/auth/bind_relation_list?source_game_zone=codev&game_zone=codev
body: { source_game_zone, game_zone }
→ data.list[]: { uin, nickName, selfUuid, type, thirdType, iconUrl, isVerification }
```

**一个必须知道的坑：`nickName` 是第三方昵称，不是游戏名。**

实测同一个号：列表里 `nickName` 是「看见」（`iconUrl` 是 `thirdwx.qlogo.cn` 微信头像），
而登录态里 `role.name` 是「苦橘甘来」（游戏名），两边 `selfUuid` 完全一致。
直接拿 `nickName` 去当账号名绑，绑出来是错的名字。

所以代码里只在 `scene === role.uid` 时才把 `role.name` 作为 `gameName` 带上，
`own: true` 标出「这是自己那份登录态」。

### 用它解决了什么

之前 `#瓦绑定` 全靠用户把名字打对 —— 掌瓦没有按昵称搜人的接口，
打错（或游戏里改过名）就只回一句「没认出来这是什么账号格式」，很折磨人。现在：

- `#瓦可选账号` 把真实能查的号列出来，`#瓦绑定 序号` 直接选，不用猜
- `getAccount()` / `getProfile()` 认名字时多兜一层：昵称对得上、且是自己那条，就放行，
  并按 `gameName` 回（不把微信昵称当账号名）
- 认不出名字时，回复里直接带上这份列表

### 同一批接口里其他几条的状态

| 接口 | 状态 |
| --- | --- |
| `get_sdk_ticket` | ✅ 出 ticket |
| `cancellogout` | ✅ |
| `login_by_qq` / `login_by_wechat` | ✗ 要 `infotype` / `code`，四个入口（body/query/header/cookie）都塞不进去，是服务端签名中间件填的 |
| `refresh_client_ticket` / `get_client_tmp_ticket` / `get_web_ticket` | ✗ 要 `ct`（448 字符那张），需 App 签名 |
| `verification` | ✗ `ClientType 类型不支持` |
