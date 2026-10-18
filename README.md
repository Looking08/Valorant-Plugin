# 无畏契约插件

给云崽（TRSS-Yunzai / Yunzai V3）加无畏契约查询，出图。手游国服掌瓦的数据能查，指令前缀 `#瓦`。

先说一件要紧的事：**数据得自己抓包。** 扫码登录或许后续会推出OS：不会搞
每人抓一次、发一次 `#瓦导入`。

## 效果如图

<img src="docs/screenshots/panel.jpg" width="820">

`#瓦面板` — 段位、K/D、ACS、爆头率、常用特工、主要地图、近期走势。

<img src="docs/screenshots/matches.jpg" width="820">

`#瓦战绩` — 最近 10 场。MVP 和「全场第 N」直接打在右上角，不用自己算。

<img src="docs/screenshots/detail.jpg" width="820">

`#瓦战绩详情` — 十个人逐项摆开，🔵 我方 🔴 敌方，自己那行左边有道亮条。

## 安装

在云崽根目录：

```bash
git clone https://github.com/Looking08/Valorant-Plugin.git ./plugins/Valorant-Plugin
cd ./plugins/Valorant-Plugin && pnpm install
```

目录名得是 `Valorant-Plugin`，代码里写死了。重启云崽，日志里出现「无畏契约插件载入完成 / 成功加载：8 个」就算挂上了。

之后升级用 `#瓦更新`，不用再进目录。

<details>
<summary>docker 跑 TRSS_AllBot 的看这里</summary>

插件目录是容器里的 `/root/TRSS_AllBot/TRSS-Yunzai/plugins/Valorant-Plugin`，
宿主机一般在 `~/TRSS_AllBot/TRSS-Yunzai/plugins/`，直接扔进去，TRSS 会热加载。
</details>

## 起数据源

插件不直接连游戏接口，中间隔一个小网关（`bridge/`，零依赖）：

```bash
cd plugins/Valorant-Plugin
TOKEN=你的令牌 pnpm bridge
```

然后把 `config/config/config.yaml` 改成一样的：

```yaml
gateway:
  url: 'http://127.0.0.1:7820'
  token: '你的令牌'
```

配置热更新，不用重启。默认数据源是 `demo`，不配登录态也能出图，就是数据假的，拿来调 UI 正好。

要真实数据就换 `mateapp`：

```bash
cp bridge/providers/mateapp.example.json bridge/mate.json
PROVIDER=mateapp TOKEN=你的令牌 pnpm bridge
```

## 指令

| 指令 | 干什么 |
| --- | --- |
| `#瓦面板` | 生涯面板 |
| `#瓦战绩 [条数]` | 最近对局，默认 10，最多 30 |
| `#瓦战绩详情 <序号>` | 单局详情。`#瓦对局详细 9`、`#瓦详细 9` 也认 |
| `#瓦枪械 [击杀\|爆头\|伤害\|命中\|回合]` | 枪械熟练度 |
| `#瓦登录` | 抓包步骤 + 自己的登录态状态 |
| `#瓦导入 <粘贴 cURL>` | 导入登录态，导入完就能查 |
| `#瓦登录状态` / `#瓦退出登录` | 还能不能用 / 删掉换号 |
| `#瓦绑定 昵称` | 一般用不上，导入时会自动绑 |
| `#瓦账号` / `#瓦切换 <序号>` / `#瓦删除 <序号>` | 多账号 |
| `#瓦状态` | 自检，通了没 |
| `#瓦清缓存` / `#瓦更新` | 主人的活 |

前缀写 `瓦` 或 `无畏契约` 都行，`#` 可以不写。

## 数据导入

1. 手机装个抓包 App（安卓 Reqable，iPhone Stream / Thor），按引导装证书。iPhone 还得去「设置 → 通用 → 关于本机 → 证书信任设置」把开关打开，这步忘了就什么都抓不到。
2. 开着抓包打开掌瓦，进「我的 → 战绩」，下滑一下，点进任意一局。
3. 回到抓包 App，按 `app.mval.qq.com` 过滤，找 `career/record/list`，长按 →「复制为 cURL」。再找 `career/record/player/rounds`，也复制一份。
4. 发 `#瓦导入`，把两段一起粘上来。整段粘，别删东西，插件自己拆。

有电脑的话可以省掉手抄：

```bash
node tools/har2cred.mjs 掌瓦.har                    # 打出一行，自己发群里
node tools/har2cred.mjs 掌瓦.har --docker --user=你的QQ --token=网关令牌
```

登录态几天到两周会过期，过期后查询会直接告诉你「登录态失效」，重新抓一次再导入就行，不影响别人。

## 注意事项

- 抓包这步绕不过去，对不折腾的群友确实有门槛。
- 掌瓦不给的字段就显示「—」（可能后面咕咕咕）。列表页的比分、ADR、时长，以及 KAST、枪械总伤害。

