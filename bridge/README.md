# 战绩网关 · Provider 开发说明

插件和「数据从哪来」是彻底解耦的：插件只认一份 REST 契约，网关负责把这份契约
翻译成某个具体数据源的调用。写一个新的数据源 = 写一个 provider 文件。

## 内置的三个 provider

| PROVIDER | 用途 | 要不要配置 |
| --- | --- | --- |
| `demo` | 造确定性假数据，零配置先看效果、调 UI | 不用 |
| `http` | 把请求原样转发给你已有的服务（`HTTP_UPSTREAM`） | 一个环境变量 |
| `mateapp` | 掌瓦 App 抓包对接，**真数据** | `bridge/mate.json` |

`mateapp` 是「想查真实战绩」的正解，配好之后：

```bash
cp bridge/providers/mateapp.example.json bridge/mate.json   # 填抓包来的东西
pnpm probe                                                   # 验证 + 看字段结构
PROVIDER=mateapp TOKEN=你的令牌 pnpm bridge                  # 起网关
```

完整抓包步骤、要抄哪些字段、字段对不上怎么改，见
**[providers/mateapp.md](providers/mateapp.md)**。

> 为什么不能「扫码登录掌瓦」：掌瓦是 App，没有扫码这个动作，登录走 SDK 授权，
> 换 token 需要掌瓦自己的 app secret。详见 [login/README.md](login/README.md#-掌瓦到底怎么登录先读这段别白忙)。

## 一、实现一个 provider

在 `bridge/providers/` 下新建 `xxx.js`，导出一个对象：

```js
export const xxxProvider = {
  name: 'xxx',

  // 1. 查账号：返回玩家基本信息
  async getAccount ({ query, region, user }) { return { /* ... */ } },

  // 2. 生涯面板
  async getProfile ({ account, region, user }) { return { /* ... */ } },

  // 3. 战绩列表
  async getMatches ({ account, region, count, mode, map, user }) { return { /* ... */ } },

  // 4. 单局详情
  async getMatch ({ matchId, account, user }) { return { /* ... */ } },

  // 5. 枪械数据
  async getWeapons ({ account, region, season, count, user }) { return { /* ... */ } },

  // 6.（可选）多账号：每个用户各存一份登录态
  async saveCredential ({ user, cookie, scene, sceneDetail }) { return { user, role } },
  credentialStatus ({ user }) { return { bound, usable, role, updatedAt } },
  removeCredential ({ user }) { return { removed } }
}
```

### `user` 是什么

插件会把**发指令那个人的 QQ 号**放进 `user` 参数。数据源如果一份登录态只服务一个人
（掌瓦就是），就得靠它来决定用谁的身份；`user` 为空表示「网关默认那份」
（CLI 探针、单人自用）。

不实现 `saveCredential` 的 provider 会被网关判定为「单账号」，`/v1/creds` 直接回
`NOT_SUPPORTED`，插件侧也只会显示「当前数据源不支持按人导入」，不会假装成功。

### 多账号 provider 的三条硬要求

1. **没有凭证不能回退到别人的**：抛 `NOT_BOUND`，让插件提示「你还没导入」。
   悄悄用默认登录态 = 把部署者的战绩漏给所有人。
2. **缓存按 user 隔离**：任何 `Map` 缓存 key 都要带 user 前缀，否则会串号
   （掌瓦这边踩过：赛季号串了会把 A 的记分板当 B 的返回）。
3. **验证通过再留档**：`saveCredential` 里先用这份凭证打一次真实请求，
   失败就把刚写的文件删掉。半份坏凭证比没有更麻烦。

然后在 `providers/index.js` 的 map 里注册一句 `xxx: xxxProvider`，
启动网关时 `PROVIDER=xxx node bridge/server.mjs` 即可。

## 二、错误怎么抛

`throw` 一个 `Error`，并把 `error.code` 设成下表之一，网关会翻译成对应的 HTTP 状态
和插件能识别的错误码；用户看到的是一句人话，不是 JSON。

| code | 含义 | HTTP |
|------|------|------|
| `NOT_FOUND` | 查无此账号 / 资源不存在 | 404 |
| `NOT_BOUND` | 这个用户还没导入登录态（多账号） | 409 |
| `BAD_REQUEST` | 参数不对（缺 user、不是合法 JSON 等） | 400 |
| `PRIVATE` | 对方关闭了战绩公开 | 403 |
| `RATE_LIMIT` | 上游限流 | 429 |
| `UPSTREAM_AUTH` | 登录态失效 / key 过期 | 502 |
| `NOT_SUPPORTED` | 这个数据源不支持该功能 | 501 |
| `UPSTREAM`（默认） | 其它上游错误 | 502 |

## 三、返回数据结构约定

⚠️ 关键：**给 id，不给名字**。特工 / 地图 / 武器统一返回
valorant-api 的 `uuid`（或 `腾讯.resource id`），中文名和图标由插件侧
`utils/staticData.js` 补齐。这样不同数据源的数据都能被同一套模板渲染，
也不会出现「同一个数据源把 AgentJett 写成三种名字」的尴尬。

### getAccount

```jsonc
{
  "puuid": "5f3a...-...",
  "id": "张三#1234",          // 展示用
  "name": "张三",
  "tag": "1234",
  "region": "ap",
  "accountLevel": 214,
  "title": "玩家称号",
  "card": { "small": "https://...png", "large": "", "wide": "" }
}
```

### getProfile

```jsonc
{
  "account": { /* 同上 */ },
  "rank":     { "tier": 21, "tierName": "超凡一", "rr": 62, "icon": "https://...png", "act": "第9幕第3章" },
  "peakRank": { "tierName": "神话一", "icon": "https://...png", "act": "第9幕第2章" },
  "stats": {
    "matches": 412, "wins": 231, "losses": 181, "winRate": 0.56,
    "kills": 6821, "deaths": 5902, "assists": 1890, "kd": 1.16,
    "acs": 241.3, "adr": 152.7, "kast": 0.73, "headshotRate": 0.284,
    "playtimeHours": 186, "roundsPlayed": 8642
  },
  // 比率类字段：0~1 的小数；插件负责转成百分数展示
  "agents": [ { "id": "<uuid>", "matches": 63, "winRate": 0.57, "kills": 1092, "deaths": 940, "kd": 1.16, "acs": 254, "playtimeSeconds": 138000 } ],
  "maps":   [ { "id": "<uuid>", "matches": 41, "winRate": 0.61 } ],
  "trend":  [ { "label": "#1", "value": 268 } ]   // 可选，画近期 ACS 折线/柱状
}
```

### getMatches

```jsonc
{
  "account": { "id": "张三#1234", "region": "ap", "card": {"small": "..."} },
  "list": [
    {
      "matchId": "a1b2c3-...",
      "mapId": "<uuid>", "mode": "competitive",
      "result": "win",                 // win | lose | draw
      "scoreSelf": 13, "scoreEnemy": 9,
      "agentId": "<uuid>",
      "kills": 24, "deaths": 15, "assists": 6,
      "kd": 1.6, "acs": 298, "adr": 187, "headshotRate": 0.31,
      "roundsPlayed": 22, "durationSec": 1830, "startedAt": 1760000000,
      "accountId": "张三#1234",         // 详情接口会回传
      "mvp": true,                     // 可选：本局全场最佳
      "rankInMatch": 1                 // 可选：本局全场名次（1 = 最佳），给了就能标「全场#3」
    }
  ],
  "summary": { "matches": 10, "wins": 6, "losses": 4, "winRate": 0.6, "acs": 241, "kd": 1.21 }
}
```

`mode` 建议直接给英文关键字（competitive / unrated / swiftplay / deathmatch …），
插件 `utils/format.js` 里有对照表。

### getMatch

```jsonc
{
  "matchId": "a1b2c3-...",
  "mapId": "<uuid>", "mode": "competitive",
  "result": "win", "scoreSelf": 13, "scoreEnemy": 9,
  "durationSec": 1830, "startedAt": 1760000000,
  "myTeam": "red",                   // 我在哪一队。不给也能跑：插件会找 isSelf 那一条
  "rankInMatch": 1,                  // 我在全场的名次（1 = MVP）
  "mvp": true,
  "rounds": [ { "side": "atk", "result": "win" } ],   // 顺序即回合顺序
  "players": [
    {
      "agentId": "<uuid>", "id": "张三#1234",
      "agentName": "芮娜",              // 没有 uuid 的数据源直接给名字
      "agentIcon": "https://...png",   // 同上，给了就不用查 valorant-api
      "team": "red",                    // Blue / Red —— 这是**阵营**，不是敌我
      "isSelf": true,                   // 哪条是我：插件靠它算敌我 + 标「我」
      "startTeam": "atk",
      "kills": 24, "deaths": 15, "assists": 6, "kd": 1.6, "acs": 298,
      "econ": 4200, "headshots": 12, "headshotRate": 0.31,
      "firstBloods": 4, "plants": 3, "defuses": 1,
      "rank": { "tierName": "超凡一", "icon": "https://...png" }
    }
  ]
}
```

> ⚠️ `team` 是阵营（攻守轮换不变），**不要**用它表达敌我：我在红队时红才是我方。
> 插件用 `myTeam` / `isSelf` 自己算 `side`，所以只要 `team` 填对、`isSelf` 标对就没问题。

### getWeapons

```jsonc
{
  "account": { "id": "张三#1234", "region": "ap", "card": {"small": "..."} },
  "season": "全部数据",
  "list": [
    {
      "weaponId": "<uuid>",
      "kills": 1284,
      "headshots": 431, "bodyshots": 902, "legshots": 51,
      "damage": 231400,
      "roundsUsed": 620
    }
  ]
}
```

爆头率、每发伤害、每回合击杀这些派生指标插件自己算，provider 不用管。

## 四、想对接国服 / 手游怎么办

掌上无畏契约（`com.tencent.apps.valorant` / 游戏内 H5）的接口需要 App 登录态，
只能抓包拿到，而且随时可能变。建议的姿势：

1. 用抓包工具（Reqable / Charles / HttpCanary）登录掌瓦，导出相关请求；
2. 写一个**只有你自己用**的小服务，把「riot id → 战绩」这段流程封起来，
   顺手把登录态做成可定时刷新的（抓来的 token 有效期普遍不长，不刷新就等着失效）；
3. 用 `PROVIDER=http` + `HTTP_UPSTREAM=http://127.0.0.1:9000` 指过去，
   你的服务返回上面约定好的结构即可；
4. 接口变了只需要改你那个小服务，插件完全不用动。

国际服可以选第三方数据 API（如 HenrikDev / Riot 官方 developer key），
同样套一层 provider。写起来 ≤ 200 行。
