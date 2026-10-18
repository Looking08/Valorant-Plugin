# 掌瓦数据源（`app.mval.qq.com`）—— 已打通，这份文档是维护手册

> 结论先说：**战绩接口全在 `https://app.mval.qq.com/go/codev/career/*` 后面，
> 认的是 Cookie + 请求体里的 `scene`。** 下面的路径、参数、字段名都是实测出来的
> （掌瓦 Android 2.9.0 / 2026-10），不是猜的。`mateapp.js` 已按这份结果写实，
> 你只需要抓一次包把凭证填进 `bridge/mate.json`。

## 0. 三个坑（改代码之前必须先知道）

| 坑 | 表现 | 正确做法 |
| --- | --- | --- |
| `result` 是**字符串** `"0"` | 用 `result === 0` 判断，全部请求都算失败 | `String(json.result) === '0'`，配置里写 `okValues: [0, "0"]` |
| `scene` 是**会话级 blob**，还分两份 | 拿列表那份 scene 去查回合，返回空数组 | 列表/概览/枪械用 `scene`（约 175 字符），**单局回合**用 `sceneDetail`（约 91 字符） |
| 接口之间靠**三个 id** 串 | 拿 `battle_id` 直接查记分板，返回空 | 记分板还要 `queue_id = game_mode_id`（竞技=101），回合还要 `game_mode = game_submode_id`（竞技=101001） |

第三条 `mateapp.js` 已经替你处理了：列一次战绩表就把每局的
`game_mode_id / game_submode_id` 记在内存里（30 分钟），查详情时自动带上。

---

## 1. 接口全景（都已实测跑通）

`POST https://app.mval.qq.com<path>?source_game_zone=codev&game_zone=codev`

| 键（mate.json） | 路径 | 靠什么认人 | 给什么 |
| --- | --- | --- | --- |
| `profile` | `/go/codev/career/seasonoverview` | Cookie + scene | 当前段位、赛季最高、胜率、平均战斗得分、总场次、总时长、段位趋势、命中分布 |
| `stat` | `/go/codev/career/record/statdata` | 同上 | ACS / KDA / 精准击败 / 回合伤害 / 击杀·死亡·助攻 / 率先击败… |
| `agents` | `/go/codev/career/performance/agent` | 同上 + `season_id` `queue_id` | 每个特工的场次、胜率、K/D、使用时长 |
| `maps` | `/go/codev/career/performance/map` | 同上 | 每张图的胜率、K/D、回合得分 |
| `weapons` | `/go/codev/career/performance/gun` | 同上 | 每把枪的击杀、精准击败率、每回合击杀、最远击杀 |
| `recent` / `matches` | `/go/codev/career/record/list` | Cookie + scene + baton | 战绩列表（一页 10 条，`next_baton` 翻页） |
| `match` | `/go/codev/career/record/scoreboard` | + `battle_id` `queue_id` | 双方十人明细 + 比赛结果 + 时长 |
| `matchRounds` | `/go/codev/career/record/player/rounds` | + `battle_id` `game_mode` | 逐回合胜负/攻防/个人数据 |
| `roundOverview` | `/go/codev/career/record/player/roundoverview` | + `round_num` | 单回合的对手、枪械、技能（暂未渲染，探针会打） |

`season_id` 不用你填：`seasonoverview` 的 `season_list` 会给出当前赛季 key
（序幕八 = `"8"`），`mateapp.js` 运行时自己推，换赛季自动跟进。

### 请求长什么样

```
POST /go/codev/career/seasonoverview?source_game_zone=codev&game_zone=codev
content-type: application/json; charset=utf-8
cookie: clientType=9; appid=10200; openid=...; access_token=...; userId=...; accountType=2; tid=...
user-agent: mval/2.9.0.10070 Channel/6 Manufacturer/OnePlus  ...

{"scene":"v3_...","mode":"255","season":"","source_game_zone":"codev","game_zone":"codev"}
```

不需要 Referer / Origin / 签名。**UA 最好照抄**，`mval/2.9.0...` 这串是它的身份。

---

## 2. 字段口径（跟 Riot 官方 API 不是一套）

写页面/改 mapper 之前先看这张表，几个词是「同名不同义」：

| 掌瓦字段 | 真实含义 | 容易误读成 |
| --- | --- | --- |
| `score`（列表里） | **ACS**（平均战斗得分） | 比分 13-11 |
| `winning_games` / `failed_games` | 我方/对方**回合数**，只有详情页有 | — |
| `kill_head` | 精准击败**率**（`22.0` = 22%） | 爆头击杀数 |
| `kda_score` | (击杀+助攻)/死亡 | — |
| `part`（特工） | 该特工的**场次**（27 场 × 20 分钟 ≈ 9h，跟 `time` 对得上） | 使用占比 27% |
| `round_won` / `round_fail`（列表） | **实测恒为 `"0"`**，别拿它算比分 | 回合数 |
| `content` | `竞技模式 \| 天枢云阙`，最后一段才是地图 | 固定两段 |

上游**没有**的东西（对应界面显示「—」而不是 0）：

- KAST、总命中次数、枪械总伤害
- 列表里的比分、时长、ADR、爆头率（只有详情页有）
- 地图场次
- 段位分数 RR（只有段位图标和名字）

---

## 3. 抓包：只为了拿凭证

要的就三样：**Cookie**、**`scene`**、**`sceneDetail`**。
（角色名和 `role_id` 不用抄 —— 导入时机器人会自己从记分板里认出来。）

### 3.1 抓

**电脑 + 手机同 Wi-Fi（推荐，导出 HAR 最省事）**

1. 电脑装 [Reqable](https://reqable.com/)（或 Charles / Fiddler / mitmproxy）
2. 手机 Wi-Fi 设置里填代理：电脑 IP + 端口（Reqable 默认 9000）
3. 手机浏览器打开 `http://电脑IP:9000`，按提示装 CA 证书
   - **iOS**：装完还要去「设置 → 通用 → 关于本机 → 证书信任设置」把开关打开，
     不开的话抓到的全是 TLS 错误
   - **Android 7+**：用户证书默认不被 App 信任，需要 root 装进系统证书区，
     或者用 Reqable 的虚拟机/免 root 方案
4. 电脑端确认 **「记录请求体 / Capture POST body」是开着的** —— 关掉的话
   `scene` 在 body 里，你就永远抓不到它（这是最常见的失败原因）
5. 手机打开掌瓦：「我的 → 战绩」，往下滑一点，再点进任意一局（详情页）
6. 电脑端按 `app.mval.qq.com` 过滤，然后 **File → Export → HAR**

**手机上直接抓（Thor / Stream / HttpCanary）**
也能出 HAR，导出后发给自己（QQ 文件传输助手 / 邮件），再拷到电脑上。这条路适合没有电脑的场景。

### 3.2 交给云崽：三条路，按你的部署选

#### ① 云崽跑在 docker 里（你这台就是）—— 一条命令

```bash
cd ~/TRSS_AllBot/TRSS-Yunzai/plugins/Valorant-Plugin
node tools/har2cred.mjs ~/Downloads/掌瓦.har --docker --user=你的QQ号 --token=你的网关令牌
```

它做三件事：把 HAR 拷进容器 → 在容器里跑本脚本推给容器内的网关 → 删掉临时文件。
输出末尾出现 `✅ 已推给网关：user=… 角色=…（已验证可用）` 就成了。

> 为什么必须进容器：TRSS 一键镜像是 bridge 网络，网关只听容器自己的
> `127.0.0.1:7820`，宿主机直连是 **refused**。`--docker` 就是替你处理这个。

#### ② 云崽直接跑在宿主机（没有 docker）—— 也是一条命令

```bash
node tools/har2cred.mjs 掌瓦.har --push --user=你的QQ号 --gateway=http://127.0.0.1:7820 --token=你的令牌
```

#### ③ 群友（只有 QQ 聊天，碰不到后端）—— 复制 cURL 直接粘

这是最常见的情况，也是最容易做砸的一步：别让他们手抄 cookie（600 多字符，必错）。
抓包 App 里长按请求 →「复制为 cURL」，整段粘进 QQ 即可：

```
#瓦导入 curl 'https://app.mval.qq.com/go/codev/career/record/list?...' \
  -H 'cookie: clientType=9; ...; userId=JA-...;' \
  --data-raw '{"scene":"v3_...","baton":"","mode_filter":""}'

curl 'https://app.mval.qq.com/go/codev/career/record/player/rounds?...' \
  -H 'cookie: clientType=9; ...' \
  --data-raw '{"scene":"v3_...","battle_id":"...","game_mode":"101001"}'
```

`parsePayload()` 会做这些事：

| 输入形态 | 怎么处理 |
| --- | --- |
| cURL（`-H 'cookie:'` + `--data-raw`） | 从 headers 取 cookie，从 body JSON 取 scene |
| 原始 HTTP 请求（`Cookie:` 头 + 空行 + body） | 同上 |
| 两条 cURL 一起贴 | 按 body 里 `baton` / `battle_id` 分清列表 scene 与详情 scene |
| `cookie\|scene\|sceneDetail` | 直接切三段 |
| 多行 `cookie=` / `scene=` | 逐行取 key=value |
| 只有 cookie | 收下，然后明确回「还差 scene」 |

> 为什么不支持发 HAR 文件：跑在 OneBot v11 / Milky 这类协议端上时，
> 群文件只有 `fid`，拿不到直链；各端下载 API 差异很大，与其做个时灵时不灵的，
> 不如明确提示「复制 cURL」。截图也不行 —— cookie 600 多字符，OCR 必错字。

**发给谁就绑到谁名下**（用的是发指令那个 QQ 号），所以别替别人转发。

#### ③-b 主人自己（有后端权限）—— 一条命令

```bash
node tools/har2cred.mjs 掌瓦.har
```

会打印：

```
#瓦导入 clientType=9; appid=…; access_token=…; userId=JA-…;|v3_fMPw…|v3_vXjA…
```

整行复制，在群里发给机器人即可。

### 3.3 机器人是怎么「识别」的

`#瓦导入` 收到之后，网关按顺序做四件事，任何一步失败都会把结果说清楚：

| 步骤 | 做什么 | 失败的样子 |
| --- | --- | --- |
| 1 | 从 cookie 里取 `userId=JA-…` 当 `role.uid` | 缺 cookie → 「cookie 是空的」 |
| 2 | 检查 scene 在不在（**不许借用 base 的**） | 缺 → 「还差 scene」 |
| 3 | 用这份凭证打一次真实请求：`record/list` | 抄漏/过期 → `UPSTREAM_AUTH`「登录态失效」 |
| 4 | 拿最近一局的 `record/scoreboard`，找 `is_me == "1"` 那条 → `user_name` + `role_id` | 认不出来 → 存下但提示「角色名没认出来」 |

第 3 步失败会**删掉刚写的文件**，不留半份坏凭证。第 4 步认出的角色名会自动帮你绑定，
所以导入完直接 `#瓦面板` 就行，不用再 `#瓦绑定`。

### 3.4 抓不到 / 抓到了没用

| 现象 | 原因 |
| --- | --- |
| 手机 App 里一直转圈、抓包里看不到 mval 请求 | 证书没信任（iOS 忘了开开关）或代理没生效 |
| 有请求但响应全是乱码 / TLS 错误 | App 做了 SSL Pinning。试旧版本 App，或模拟器 + frida（`frida-multiple-unpinning`） |
| 工具说「请求体里没有 scene」 | 没开「记录 POST body」；或者抓的时候没进战绩页 |
| 导入后报 `result=1001/1002 登录态失效` | 抓包时登录态就过期了，重开掌瓦登录一次再抓 |
| 导入成功但列表是空的 | `scene` 抄错页了：列表用 `record/list` 的，详情用 `player/rounds` 的 |
| 发了群文件 / 截图，机器人没反应 | 协议端拿不到文件直链，截图 OCR 也认不准 —— 会明确回「改用复制 cURL」 |

> `scene` 填错时接口**不会报错**，只会给你 `data: []` 或空 `battle_list` ——
> 这是最难查的一种失败，所以探针会把「通了但没数据」单独标出来。

---

## 4. 验证：`pnpm probe`

```bash
cp bridge/providers/mateapp.example.json bridge/mate.json   # 填好上面那三样
pnpm probe                  # 10 条接口逐条验活
pnpm probe --map            # 再跑一遍映射，直接看插件会渲染成什么
pnpm probe match            # 只探一条
```

探针会：

1. 先检查配置漏项（cookie / scene / uid 没填会直接告诉你）
2. 逐条打接口，成功打印字段结构，失败按 `UPSTREAM_AUTH` / `NOT_FOUND` /
   `NOT_CONFIGURED` 给出人话原因
3. 把原始 JSON 存到 `bridge/.state/mate-probe-<名字>.json`（上游改结构时照着它改 mapper）
4. 单局那几个接口需要 `battle_id`，探针会先拉一次列表取第一条自动填，不用手输

`--map` 的输出就是插件要渲染的数据，字段错了在这一步就能看出来，不用等出图。

---

## 5. 起网关

```bash
PROVIDER=mateapp TOKEN=你的令牌 node bridge/server.mjs
```

日志出现这两行就成了：

```
数据源 provider：mateapp
多账号：已开启（已导入 0 份登录态）
```

---

## 5.5 多账号：一人一份登录态

### 为什么必须这样

掌瓦的接口**只认 cookie 里那个人的身份**，没有任何「按名字查别人」的入口
（`getAccount` 一旦发现你查的名字不是当前登录角色，直接 `NOT_SUPPORTED`）。
所以想让群里 N 个人各查各的，只能是 N 份登录态。

### 存哪

| 文件 | 谁写 | 内容 |
|------|------|------|
| `bridge/mate.json` | 部署者手填一次 | 接口路径、武器表、默认参数（所有人共用） |
| `bridge/accounts/<QQ号>.json` | `#瓦导入` 自动写 | 只有 `login` / `role` / `updatedAt` |

生效配置 = `deepMerge(mate.json, accounts/<QQ>.json)`，
所以接口路径这类静态信息只维护一份，用户文件里只有会变的三样东西。

```
请求带 user=10001 ──▶ resolveConfig('10001')
                        ├─ accounts/10001.json 存在 → 合并后返回
                        ├─ 不存在且 allowShared:true → 回退到 mate.json
                        └─ 不存在 → 抛 NOT_BOUND（绝不偷偷用别人的）
```

`NOT_BOUND` 这条是硬约束：**没导入过的人拿到的是「你还没导入」，不是机器人主人的战绩。**

### 导入怎么走

```bash
# 电脑上抓到 HAR
node tools/har2cred.mjs 抓包.har                       # 打印一行 #瓦导入 ...
node tools/har2cred.mjs 抓包.har --push --user=10001 \
  --gateway=http://127.0.0.1:7820 --token=你的令牌      # 直接推，顺带验证
```

或者群里发：

```
#瓦导入 <cookie>|<scene>|<sceneDetail>
#瓦导入
cookie=clientType=9; ...
scene=v3_xxx
sceneDetail=v3_yyy
```

### 导入时做了什么

1. `normalizeCookie()`：去掉 `Cookie:` 前缀、引号、折行
2. **要求必须有 scene** —— base 里的 scene 属于部署者，借用会串号，所以直接拒绝
3. 先落盘（验证要读配置），再打一次真实请求：`record/list` → `record/scoreboard`
4. 从记分板里 `is_me == "1"` 那条取 `user_name` / `role_id` 回填 `role`
5. 验证失败 → **删掉刚写的文件**并报 `UPSTREAM_AUTH`，不留半份坏凭证

### 缓存必须按用户隔离

`seasonState` / `battleState` / `boardState` 三处内存缓存全部带上 user 前缀。
不隔离的后果很具体：A 的赛季号（序幕八）会带进 B 的请求里，
轻则查空，重则把 A 的记分板当成 B 的牌面返回。

网关那层 `putCache` 的 key 也加了 `user`，同理。

### 单人自用

只有你自己用的话，两种做法都行：

- 照常 `#瓦导入` 一次（推荐，路径和多人一致）
- 或者直接在 `mate.json` 里加 `"allowShared": true`，让不带 user 的请求回退到那份登录态

**多人场景别开 `allowShared`** —— 那等于所有人都看你的数据。

---

## 6. 登录态会过期

Cookie / scene 一般几天到几十天。过期的表现：探针报 `UPSTREAM_AUTH`，
或者插件提示「数据源登录态失效了」，也可能是 `data` 突然全空。

**多人场景**：每个人重新 `#瓦导入` 一次自己的就行，不影响别人。
**单人场景**：改 `bridge/mate.json` 里的 `login.cookie` / `login.scene`，不用重启网关
（配置按 mtime 缓存，下一次请求自动生效）。

---

## 7. 为什么不能扫码登录

这段单独写，因为每隔一阵就会有人问一次。

掌瓦的登录态是 cookie（`access_token` / `openid` / `userId`）+ 请求体里的 `scene`。
两者都是 QQ/微信 原生 SDK 授权后由腾讯**下发给掌瓦 App 自己**的，签名在 App 里。
服务端要复现这条链路，得先拿到 App 的签名密钥 —— 这不是「难」，是不存在可行路径。

实测记录：

| 尝试 | 结果 |
| --- | --- |
| QQ 扫码（`ptqrlogin`） | 出码成功；轮询接口返回 **HTTP 200 + 空 body**，判定 TLS 指纹风控，连续 5 次后放弃 |
| 微信网页版（`wxweb`） | 能真扫上、能拿到 `skey`/`pass_ticket`，但那是**微信会话**，调不了 `mval.qq.com` |
| 微信开放平台（`wx`） | 需资质审核；换来的 openid 与掌瓦 appid 对不上 |
| `/go/auth/refresh_client_ticket` | 能用 cookie 换到新的 `ct`（7 天），但换不出 `scene` |

最后一行值得记一下：`ct` 是客户端票据，`scene` 是页面级会话 blob
（实测同一个 HAR 里有 3 个不同的 scene：列表/概览一个、逐回合一个、红点一个）。
所以「用 cookie 自动续 scene」这条路也堵着。

结论：`provider.saveLogin()` 特意写成直接返回 `{saved:false, hint}`，
不实现一个假的成功 —— 免得有人以为下次就能查了。

### 7.1 为什么「王者插件能扫码，瓦不能」

被问过不止一次，这里把对比写死，省得每次重新解释。

先纠正一个常见误解：**和平精英插件也不能扫码**。它的 README 里
「扫码登陆亦或者链接授权」是**未勾选的待办**，现状同样是抓包 + 绑营地 ID。

王者荣耀插件（GloryOfKings-Plugin）确实做了，链路在 `utils/qqLogin.js`：

```
puppeteer 打开 openmobile.qq.com/oauth2.0/m_authorize
           ?client_id=1105200115&scope=all&style=qr&response_type=code
   ↓ 页面自己轮询跳转，服务端只负责拦最后一下回调
拦 auth://tauth.qq.com/?code=XXX
   ↓ POST ysdk.qq.com/cmd/QQCodeLogin（HMAC-SHA256，社区逆向的固定密钥）
accessToken / openId / payToken / refreshToken
   ↓ POST ssl.kohsocialapp.qq.com:10001/user/login（loginType=openSdk）
营地登录态：userId / token / userKey
   ↓ 三件套有效期 ~60 天 > 营地 token ~30 天
apps/campRenew.js 定时 reloginQQAccount()，免扫码续期
```

关键差异在**有没有「服务端能跑完的换票入口」**，跟插件怎么写无关：

| | 王者营地 | 掌瓦 |
|---|---|---|
| 授权 appid | QQ 互联 `1105200115` | 微信 `wxcbb49f1f39656c2a`（cookie 里 `acctype=wx`） |
| code → 登录态 | YSDK `/cmd/QQCodeLogin` → 营地 `/user/login`，两跳都是普通 HTTPS | 无。微信换 token 要 appid secret + 包名/签名校验 |
| 额外要求 | 只要 token | 每个页面级 `scene`（HAR 里 3 个不同值，响应不返回） |
| 失效后 | 三件套自续 60 天 | 只能重新抓包 |

两个可以复用的经验，万一以后掌瓦开了网页版：

1. QQ 扫码**不能在服务端纯接口做**（`ptqrlogin` 会被 TLS 指纹挡，实测 200 + 空 body），
   必须 puppeteer 在同一会话里跑完整个授权页。我试过纯接口，就是卡在这里。
2. 判断一个源能不能扫码，只看一件事：**它有没有一个接受「授权 code」并返回业务
   登录态的 HTTP 接口**。有（营地/YSDK、米游社 passport），扫码就有戏；
   没有（掌瓦），只能导入。

---

## 8. 风险与边界

- **只抓自己的账号。** 别人的登录态是他人凭证，不该由你来存。
  多账号是「每人自己导入自己的」，不是「你替大家抓」。
- `bridge/mate.json` 与 `bridge/accounts/` 都在 `.gitignore` 里，别提交、别截图外传。
  网关的 `/v1/creds` 只回角色名和时间，**永远不回传 cookie 原文**。
- 这不是公开接口，随时可能变。所以路径在配置里、字段在 `MAPPING` 里，
  变的时候改的是数据不是逻辑。
- 同账号高频调用可能触发风控。网关默认带 TTL 缓存（面板 5 分钟、战绩 2 分钟、
  单局 1 小时），别关掉。
- `performance/*` 官方注明「数据将在 1-2 小时生效」，刚打完的局看不到枪械/特工统计是正常的。
