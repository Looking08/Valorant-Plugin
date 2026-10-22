/**
 * QQ 二维码「死活」探针：不开手机也能判断一张码在 QQ 侧是活的还是死的。
 *
 * 为什么需要：手机提示「登录失败，二维码已过期」的时候，有两种完全不同的原因 ——
 *   A. 码本来就死（生成参数不对 / 页面给的码 QQ 不认）
 *   B. 码是活的，只是传到你手上时已经过了 120 秒
 * 这两种的修法完全不同，靠猜会来回改错地方。这里直接用页面自己的 qrsig
 * 去问 ptqrlogin，看 QQ 回 66（活）/ 65（死）/ 67（已扫）。
 *
 * 用法：
 *   node tools/qq-qr-probe.mjs
 */
import { createQQPageSession } from '../bridge/login/qqpage.js'

/** 腾讯的 hash33：ptqrtoken = hash33(qrsig) */
function hash33 (s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i)
  return h & 2147483647
}

const PTQR_LOGIN = 'https://xui.ptlogin2.qq.com/ssl/ptqrlogin'

const s = await createQQPageSession({ onLog: (m) => console.log('[page]', m) })
console.log('取到码：', String(s.qr).length, 'chars')

const cookies = await s.page.cookies()
const jar = cookies.map(c => `${c.name}=${c.value}`).join('; ')
const qrsig = cookies.find(c => c.name === 'qrsig')?.value || ''
console.log('cookie 名：', cookies.map(c => c.name).join(', '))
console.log('qrsig：', qrsig ? qrsig.slice(0, 10) + `…（${qrsig.length}）` : '❌ 没有')
console.log('qr src：', String(s.qrSrc).slice(0, 160))

const token = hash33(qrsig)

/** 几套参数逐个试，看哪套能拿到非空 ptuiCB */
const variants = [
  {
    name: '页面最小集（aid=716027609, daid=0）',
    params: { u1: 'https://openmobile.qq.com/', ptqrtoken: token, aid: '716027609', daid: '0', ptlang: '2052', from_ui: '1', type: '1', jsver: '28d22679', ptopt: '1', pt_uistyle: '35' }
  },
  {
    name: '掌瓦 App 集（daid=381, pt_3rd_aid=102061775）',
    params: { u1: 'http://connect.qq.com', ptqrtoken: token, aid: '716027609', daid: '381', pt_3rd_aid: '102061775', ptlang: '2052', from_ui: '1', type: '1', jsver: '28d22679', ptopt: '1', pt_uistyle: '35', device: '2' }
  }
]

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 15; V2366GA Build/V417IR; wv) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Safari/537.36 tencent_game_emulator'

for (const v of variants) {
  const qs = new URLSearchParams({ ...v.params, r: String(Math.random()) })
  try {
    const res = await fetch(`${PTQR_LOGIN}?${qs}`, {
      headers: {
        'User-Agent': UA_MOBILE,
        Accept: '*/*',
        Referer: s.page.url(),
        'X-Requested-With': 'com.tencent.apps.valorant',
        Cookie: jar
      },
      signal: AbortSignal.timeout(15000)
    })
    const text = (await res.text()).trim()
    const code = /ptuiCB\('(\d+)'/.exec(text)?.[1] || ''
    const meaning = { 66: '活（未扫码）', 67: '已扫码待确认', 65: '死（已过期）', 0: '成功' }[code] || '未知'
    console.log(`\n[${v.name}]`)
    console.log(`  HTTP ${res.status}  长度 ${text.length}  码 ${code || '(空)'} → ${meaning}`)
    console.log(`  原文：${text.slice(0, 160) || '(空)'}`)
  } catch (error) {
    console.log(`\n[${v.name}] 请求失败：${error.message}`)
  }
}

await s.close?.()
process.exit(0)
