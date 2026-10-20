# 扫码登录这条路：存在，只是跟我原来想的不一样

2026-10-20 看了 `wuche-2453198/astrbot_plugin_valorant_analysis`，把他们的方法抄下来核对了一遍。

## 结论先说

**机器人亮码、用户扫、机器人拿到掌瓦登录态 —— 这条路是通的**，走的是
「QQ 互联 OAuth 扫码」而不是掌瓦 App 里那个「扫一扫」。

我之前的判断错在把两件事混成一个：

| | 谁扫谁 | 结果 |
| --- | --- | --- |
| 掌瓦 App 的「扫一扫」 | 掌瓦扫 PC 客户端上的码 | 把登录态发给 **PC 客户端**（掌瓦是授权方） |
| 这里说的扫码登录 | 用户用 QQ 扫机器人给的码 | 机器人自己拿到掌瓦登录态 |

第二条跟我原先说的「服务端复现不了」不冲突 —— 复现不了的还是那个 448 字符的 `ct`，
但 **`ct` 不用自己算，是掌瓦换给你的**。

## 链路

```
1) GET  xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=716027609&pt_3rd_aid=102061775&daid=381&...
        → 拿 Cookie 里的 pt_login_sig / idt / qrsig

2) GET  xui.ptlogin2.qq.com/ssl/ptqrshow?appid=716027609&daid=381&pt_3rd_aid=102061775&...
        → 二维码图片（PNG 直接发给用户）

3) GET  xui.ptlogin2.qq.com/ssl/ptqrlogin?ptqrtoken=<calc_ptqrtoken(qrsig)>&...
        轮询到 code=0 → redirect_url 指向 check_sig

4) 追 check_sig 跳转（最多 5 跳）→ 最终落到
        auth://tauth.qq.com/...#access_token=<...>&openid=<...>

5) POST app.mval.qq.com/go/auth/login_by_qq?source_game_zone=agame&game_zone=agame
        Cookie: clientType=9; openid=null; access_token=null
        {
          clienttype: 9,
          config_params: { client_dev_name: "23117RK66C", lang_type: 0 },
          login_info: { appid: 102061775, openid, qq_info_type: 5, sig: access_token, uin: 0 },
          mappid: 10200,
          mcode: "132f0a77d34402abc8463d60100011d19b0e",
          source_game_zone: "agame", game_zone: "agame"
        }
        → data.login_info: { user_id, wt, uin, ct, ctt, sk }
```

`ct` 就是我要的那张票据。之后请求一律带：

```
Cookie: clientType=9; uin=o{uin}; appid=102061775; acctype=qc;
        openid={openid}; access_token={access_token};
        userId={user_id}; accountType=5; tid={wt}
```

## 我已经核实过的部分

用现有登录态直接打了几个端点（`/tmp/probe_agame.mjs` 可复现）：

| 端点 | 结果 |
| --- | --- |
| `/go/auth/login_by_qq` | **端点存在**，空参返回 `result=1002 参数错误`（不是 404） |
| `/go/account/get_main_role_raw` | ✅ result=0 |
| `/go/mine/card/val_card` | ✅ result=0 |
| `/go/auth/get_sdk_ticket` | ✅ result=0 success |
| `/go/agame/career/record/list` | ❌ result=1003（下面说） |
| `/go/agame/career/mode/filter` | ❌ 404 |

**没验的部分**：整套 ptlogin2 流程 + 真扫码。要验得真拿手机扫一次，
这不是我能自己跑完的 —— 得让机器人起个二维码出来。

## 一个重要的坑：game_zone 有两套

他们全程用 `game_zone=agame` + `/go/agame/*`，我一直用 `codev` + `/go/codev/*`。

拿现有登录态实测：**agame 这套返回 result=1003「请求失败」，codev 才能用**。
所以 zone 不是随便换的，大概率跟账号/客户端版本绑定。

好在**两边返回的字段是同一套**：记分板里 `head_shots_rate`、`damage`、
`first_kill_count`、`plant_count`、`defuse_count`、`clutch`、`ace`、`economy`、
`tier_name`、`is_friend` 全都有。也就是说他们 `API_FIELDS.md` 里记的字段
对 `codev` 一样成立 —— 我之前以为「掌瓦不给」，其实是我没取，见 `attachRanks()`。

## 如果真要做

1. 参数不能照抄死值：`LOGIN_URL_TEMPLATE` 里带了 `time=1763280194`、`h5sig=...`
   这类一次性签名，`mcode` 也标了「可能需要更新」。硬编码迟早失效。
2. 优先看 `astrbot_plugin_val_shop`（GuJi08233，AGPL-3.0）—— 这套 QQ 互联参数
   是从那边整理来的。AGPL 有传染性，**抄参数可以，抄代码要看许可证**。
3. 插件里 `bridge/login/` 已经有适配器骨架，真接的话落在那儿。
