# 无畏契约插件

给云崽（TRSS-Yunzai / Yunzai V3）加无畏契约查询，直接出图。手游国服掌瓦的数据能查，指令前缀 `#瓦`。

**登录不用抓包**：`#瓦微信登录` 微信扫一下，或者 `#瓦扫码登录` 用手机 QQ 扫一下。
微信零配置秒出码；QQ 要网关机器上有个 Chrome/Chromium。真扫不通再退回抓包，`#瓦导入` 粘一次就行。

## 效果如图

<img src="docs/screenshots/panel.jpg" width="820">

`#瓦面板` — 段位、K/D、ACS、爆头率、常用特工、主要地图、近期走势。

<img src="docs/screenshots/matches.jpg" width="820">

`#瓦战绩` — 最近 10 场。MVP 和「全场第 N」直接打在右上角，不用自己算。

<img src="docs/screenshots/detail.jpg" width="820">

`#瓦战绩详情` — 十个人逐项摆开，🔵 我方 🔴 敌方，自己那行左边有道亮条。

## 安装

只支持云崽系（Yunzai V3 / TRSS-Yunzai / Miao 等），**目录名必须是 `Valorant-Plugin`**，代码里写死了。

```bash
cd ./plugins
git clone https://github.com/Looking08/Valorant-Plugin.git ./Valorant-Plugin
cd ./Valorant-Plugin && pnpm install
```

重启云崽，日志里出现这四行就算挂上了：

```
无畏契约插件载入完成
成功加载：9 个
加载失败：0 个
```

之后升级用 `#瓦更新`，不用再进目录。

<details>
<summary>docker 跑 TRSS_AllBot 的看这里</summary>

插件目录是容器里的 `/root/TRSS_AllBot/TRSS-Yunzai/plugins/Valorant-Plugin`，
宿主机一般在 `~/TRSS_AllBot/TRSS-Yunzai/plugins/`，直接扔进去，TRSS 会热加载。

容器里还要注意两件事（不然扫码能过、图全是豆腐块）：

```bash
pacman -S --needed noto-fonts-cjk   # Debian 系：apt install fonts-noto-cjk
# /dev/shm 只有 64MB，启动参数得带 --disable-dev-shm-usage（新版本已默认带）
```

完整步骤见 [`docs/Docker云崽部署与扫码登录.md`](docs/Docker云崽部署与扫码登录.md)。
</details>

## 三分钟上手

1. 发 `#瓦微信登录`，手机微信扫机器人发来的码，点「确认」
2. 发 `#瓦战绩`，看到图就成了
3. 想查别人的：`#瓦战绩 昵称`（**只能查跟你同过场的人**）

登录态硬 3 天过期，到期重扫一次就行；`#瓦登录状态` 随时看还能不能用。

> 从 ALemonJS 过来的用户注意：本仓库**已不再提供 ALemonJS 入口**（`alemon.js`、`adapter/alemon/` 均已移除），
> 现在只维护云崽这一条线。需要旧版可以 `git log` 找到移除前的那次提交。

## 起数据源

插件不直接连游戏接口，中间隔一个小网关（`bridge/`，**零依赖**，只要装有 node）。

**网关代码随仓库一起下载，但它不会自己跑起来。** 所以插件做了一件事：发现本机网关连不上，
就自己把 `bridge/server.mjs` 拉起来（`gateway.autoStart`，默认开）。装完重启云崽，
日志里出现「[瓦插件] 已自动拉起本地网关」就是了，不用额外操作。

这时候用的是 `demo` 数据源——数据是编的，但图是真的，先看效果、调 UI 正好。

想自己管（生产环境推荐，崩了能看见日志）就手动起，插件看到端口有响应就不会再插手：

```bash
cd plugins/Valorant-Plugin
TOKEN=你的令牌 pnpm bridge          # 前台跑，Ctrl-C 停
```

然后把 `config/config/config.yaml` 的 token 改成一样的（`.url` 默认就是 `127.0.0.1:7820`，改完热更新）。

> `autoStart` **只对本机地址生效**。`gateway.url` 指向别人的机器时，连不上也不会去拉——那是人家的事。

### 换成真实数据

`demo` 之上是 `mateapp`，需要一个**你自己的掌瓦登录态**（抓包得来的 `bridge/mate.json`）：

```bash
cp bridge/providers/mateapp.example.json bridge/mate.json
# 往里填 login.cookie / login.scene，怎么来的见下面「抓包导入」
```

`gateway.provider` 留空时自动判断：`bridge/mate.json` 里有 cookie、或 `bridge/accounts/` 下已经有人导入过，
就用 `mateapp`，否则 `demo`。想锁死就填 `demo` / `mateapp`。

> **不用手动做这一步。** 直接发 `#瓦导入 <cURL>` 就行：插件会先看网关 `/health` 的 `multiUser`，
> 发现是 `demo` 就自动把它换成 `mateapp` 重起一次再导入。
> 只有网关是你自己用 systemd / tmux / `pnpm bridge` 常驻起的（插件杀不掉）才需要手动改 PROVIDER ——
> 那种情况插件会直接把该执行哪条命令打给你。

⚠️ `bridge/mate.json`、`bridge/accounts/`、`config/config/`、`data/` 都在 `.gitignore` 里，**不会随仓库分发**。
理由很直白：那几个文件里是你的登录 cookie，谁拿到谁就能查你的号。

## 指令

| 指令 | 干什么 |
| --- | --- |
| `#瓦面板` | 生涯面板 |
| `#瓦战绩 [条数]` | 最近对局，默认 10，最多 30 |
| `#瓦战绩 <昵称>` | 查同过场的人。**只能查跟你打过同一局的人** |
| `#瓦战绩详情 <序号>` | 单局详情。`#瓦对局详细 9`、`#瓦详细 9` 也认 |
| `#瓦同场` | 收录了哪些同过场的人 |
| `#瓦隐藏战绩` | 把自己从这份名单里撤掉 |
| `#瓦枪械 [击杀\|爆头\|伤害\|命中\|回合]` | 枪械熟练度 |
| `#瓦微信登录` | 机器人出微信码，扫一下登录（零配置，推荐） |
| `#瓦扫码登录` | 机器人出 QQ 码，手机 QQ 扫一下登录 |
| `#瓦登录` | 登录状态；扫码不便时给抓包步骤 |
| `#瓦导入 <粘贴 cURL>` | 抓包导入登录态，导入完就能查 |
| `#瓦登录状态` / `#瓦退出登录` | 还能不能用 / 删掉换号 |
| `#瓦绑定 昵称` | 一般用不上，导入时会自动绑 |
| `#瓦可选账号` | 列出这个登录态下真实能查的号；再 `#瓦绑定 序号` 就绑上，不用猜名字 |
| `#瓦账号` / `#瓦切换 <序号>` / `#瓦删除 <序号>` | 多账号 |
| `#瓦状态` | 自检，通了没 |
| `#瓦清缓存` / `#瓦更新` | 主人的活 |

前缀写 `瓦` 或 `无畏契约` 都行，`#` 可以不写。

## 登录

**两条路都能走，扫码是首选。**

| | 命令 | 要什么 | 状态 |
| --- | --- | --- | --- |
| 微信扫码 | `#瓦微信登录` | 什么都不用配 | ✅ 纯 HTTP，秒出码 |
| QQ 扫码 | `#瓦扫码登录` | 网关机器上有个 Chrome/Chromium | ✅ 要浏览器，约 10 秒出码 |
| 抓包导入 | `#瓦导入` | 手机上抓一次包 | ✅ 最保险，能用 3 天 |

### 微信（推荐，零配置）

微信有**两套**扫码：要 redirect_uri 白名单的「网站应用」，和**不需要白名单**的「扫码 SDK」。
掌瓦用的是后者，而且它的 `sdk_ticket` 由掌瓦自己的接口发放、免鉴权 —— 所以这条路
不需要你提供任何 appid / secret / 域名，直接就能扫。

```
get_sdk_ticket → 签名 → sdk/qrconnect 出码 → 长轮询拿 code → login_by_wechat 换凭证
```

### QQ（需要浏览器）

QQ 的授权页只能用真浏览器跑：页面里的 JS 自己完成授权，最后把 `access_token`
放在 `auth://tauth.qq.com/#…` 这个非 http 回调里，我们在旁边监听就能拿到。

**不用配路径**：插件会自己去找系统浏览器（`/usr/bin/chromium`、
`/usr/bin/google-chrome`、macOS 的 `/Applications/Google Chrome.app/…` 等十来个常见位置），
找到就直接用，省下 puppeteer 自带那份 100MB 的下载。想手动指定或彻底关掉：

```bash
export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome   # 手动指定，最高优先
export LOGIN_BROWSER=off                          # 彻底禁用，QQ 退回纯 HTTP
```

云崽宿主自带 `lib/puppeteer/puppeteer.js` 的话什么都不用装。
一个都没有会自动退回纯 HTTP 版（老版本的行为），日志里会写明。

> **早期版本说「扫码不可用」是判断错了**，错在把 `check_sig` 那条旧链路当成唯一的路：
> 那台 `ptlogin4.openmobile.qq.com` 确实被 DNS 指到 `0.0.0.1`，但带 `h5sig` 的新流程
> 根本不经过它，而是走 `openmobile.qq.com/oauth2.0/m_authlist`（活得好好的）。
> 完整更正过程见 `bridge/login/README.md` 与 `docs/掌瓦登录链路逆向.md`。

自己先验一遍（会弹出二维码，你扫一下就能看到最终结果）：

```bash
node tools/test-login.mjs wx     # 微信，秒出
node tools/test-login.mjs qq     # QQ，约 10 秒

# 走网关全链路（出码 → 扫 → 落库 → 查战绩），顺序和机器人里一模一样
USER_ID=cli node tools/gw-login-check.mjs
```

### 跑在 Docker / 容器里

能跑，微信那条零改动（容器内实测 937ms 出码）。三件事要额外注意：

1. **重启网关**：改完文件不重启，跑的还是内存里的老适配器 —— 症状是「网关没有挂载 微信 扫码适配器」
2. **装中文字体**：`pacman -S noto-fonts-cjk`（Debian 系 `apt install fonts-noto-cjk`）。
   不装的话扫码照常，但**战绩图全是豆腐块**
3. **`/dev/shm` 只有 64MB**：启动参数已带 `--disable-dev-shm-usage`，
   嫌慢可以 `docker run --shm-size=1g`

完整勘察数据、`files` 清单、排障顺序见 [`docs/Docker云崽部署与扫码登录.md`](docs/Docker云崽部署与扫码登录.md)。

### 抓包导入（兜底）

扫码不方便时（网关机器不能装浏览器、或者你手上已有一份没过期的 cookie）用这个。

1. 手机装个抓包 App（安卓 Reqable，iPhone Stream / Thor），按引导装证书。iPhone 还得去「设置 → 通用 → 关于本机 → 证书信任设置」把开关打开，这步忘了就什么都抓不到。
2. 开着抓包打开掌瓦，进「我的 → 战绩」，下滑一下，点进任意一局。
3. 回到抓包 App，按 `app.mval.qq.com` 过滤，找 `career/record/list`，长按 →「复制为 cURL」。再找 `career/record/player/rounds`，也复制一份。
4. 发 `#瓦导入`，把两段一起粘上来。整段粘，别删东西，插件自己拆。

有电脑的话可以省掉手抄：

```bash
node tools/har2cred.mjs 掌瓦.har                    # 打出一行，自己发群里
node tools/har2cred.mjs 掌瓦.har --docker --user=你的QQ --token=网关令牌
```

**登录态的有效期是硬 3 天。** 抓来的票据里带着一个底层 web ticket，服务端明确给了起止时间：

```
auth web ticket fail err=DecodeTgpTicket err=ticket expire
now=1792557703 validFrom=1792295134, validTo=1792554334
```

实测一份：`validFrom` 到 `validTo` 正好 **259200 秒 = 3 天整**，到点就失效，没有缓冲。

网关每 25 分钟续的是**上层 access_token**（那个只管 1 小时，`time_interval=3600`），
**续不到这个 3 天的底层票据** —— 真能续它的 `refresh_client_ticket` 要 `ct` 且需要 App 签名，
我们拿不到。所以：

- 3 天内：随便用，网关自己续 access_token，你不用管
- 满 3 天：查询会直接报「登录态失效」，**重新抓一次再导入**就行，不影响别人

不确定还有效没，发 `#瓦登录状态`。

## 注意事项

- 扫码能用（微信零配置，QQ 要浏览器），到期后重新扫一次比抓包省事。登录态**硬 3 天**过期，网关自动续的是上层 access_token（`KEEP_ALIVE=0` 关掉），续不到那 3 天 —— 到期重扫或重抓。
- **QQ 官方机器人（QQBot 协议端）发图要包成 segment**：直接 `e.reply(buffer)` 会让客户端显示「消息加载失败」。
  原因是 `plugins/QQBot-Plugin/adapter/build.js` 把 Message 的每个元素这么处理：
  `if (typeof i === "object") i = { ...i }` —— Buffer 是对象，会被展开成 `{0:255,1:216,…}`，
  认不出 `type:"image"`，最后当成 markdown 文本发出去，内容是字节数组的 JSON。
  插件里统一走 `imageSegment()`（`utils/render.js`）就没事，自己加指令时注意别直接塞 Buffer。
- 同一类问题还有两个后续坑：`file` 必须是**字符串**（对象会被 `Bot.Buffer` 变成 `[object Object]`，
  然后 `image-size` 报「图片分辨率检测错误」）；puppeteer 25 返回的是 `Uint8Array` 不是 `Buffer`。
  另外 QQBot 默认走 markdown，图片会被转成 `http://localhost:2536/File/…` 的链接、QQ 访问不到 ——
  没有公网域名的话把 `config/QQBot.yaml` 的 `markdown` 设成 `{机器人QQ号: legacy}`，改走原生富媒体上传。
- 掌瓦不给的就显示「—」：KAST、枪械总伤害。列表里的比分、ADR、爆头率、回合数、时长是从记分板顺手取的（不额外发请求），`mvp.lookup: false` 关掉记分板查询时它们会一起变「—」。
- 别人只能查「跟你同过一场」的，陌生人查不了：掌瓦没有按昵称搜人的接口，试过，服务端连表都没有。面板同理，只认自己的登录态。

