---

## 补充（2026-10-19 实测）：access_token 可以自己续

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
