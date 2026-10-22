/**
 * 逐跳探测掌瓦登录链路（只做无害的 GET/POST，不做任何越权动作）
 * 目的：确认每一跳在 2026-10 是否还活着、被风控、或已下线。
 */
const UA_MVAL = 'mval/2.4.0.10053 Channel/10068 Manufacturer/Xiaomi '
  + 'Mozilla/5.0 (Linux; Android 14; 23117RK66C Build/V417IR; wv) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
  + 'Chrome/101.0.4951.61 Mobile Safari/537.36'

const AID = '716027609'
const DAID = '381'
const THIRD_AID = '102061775'
const MCODE = '132f0a77d34402abc8463d60100011d19b0e'
const T = 15000

function hash33 (s) { let h = 0; for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i); return h & 0x7fffffff }
const log = (...a) => console.log(...a)

async function probeQR () {
  log('\n===== 1) xlogin → ptqrshow（能否出码）=====')
  const qs = new URLSearchParams({
    pt_enable_pwd: '1', appid: AID, pt_3rd_aid: THIRD_AID, daid: DAID,
    pt_skey_valid: '0', style: '35', force_qr: '1', autorefresh: '1',
    s_url: 'http://connect.qq.com', refer_cgi: 'm_authorize', ucheck: '1',
    fall_to_wv: '1', status_os: '12', redirect_uri: 'auth://tauth.qq.com/',
    client_id: THIRD_AID, pf: 'openmobile_android', response_type: 'token',
    scope: 'all', sdkp: 'a', sdkv: '3.5.17.lite',
    sign: 'a6479455d3e49b597350f13f776a6288',
    status_machine: 'MjMxMTdSSzY2Qw==', switch: '1',
    time: String(Math.floor(Date.now() / 1000)), show_download_ui: 'true', loginty: '6'
  })
  const loginUrl = `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?${qs}`
  let cookies = []
  try {
    const r = await fetch(loginUrl, {
      signal: AbortSignal.timeout(T),
      headers: { 'User-Agent': UA_MVAL, Accept: 'text/html,*/*;q=0.8', Referer: 'https://openmobile.qq.com/', 'X-Requested-With': 'com.tencent.apps.valorant', Cookie: 'accountType=5; clientType=9' }
    })
    cookies = r.headers.getSetCookie?.() || []
    const body = await r.text()
    log(`  HTTP ${r.status}, body ${body.length}B`)
    log(`  set-cookie: ${cookies.map(c => c.split(';')[0]).join(' | ') || '(无)'}`)
    const m = body.match(/\/monorepo\/([0-9A-Za-z]+)\/ptlogin\/js\//)
    log(`  jsver: ${m ? m[1] : '(未识别)'}`)
  } catch (e) { log('  xlogin 失败:', e.message) }

  const qrsig = (cookies.find(c => c.startsWith('qrsig=')) || '').split(';')[0].slice(6)
  const qrUrl = `https://xui.ptlogin2.qq.com/ssl/ptqrshow?${new URLSearchParams({
    s: '8', e: '0', appid: AID, type: '0', t: String(Math.random()),
    u1: 'http://connect.qq.com', daid: DAID, pt_3rd_aid: THIRD_AID
  })}`
  try {
    const r = await fetch(qrUrl, {
      signal: AbortSignal.timeout(T),
      headers: { 'User-Agent': UA_MVAL, Accept: 'image/*', Referer: loginUrl, 'X-Requested-With': 'com.tencent.apps.valorant', Cookie: `qrsig=${qrsig}` }
    })
    const buf = Buffer.from(await r.arrayBuffer())
    const sc = r.headers.getSetCookie?.() || []
    const q2 = (sc.find(c => c.startsWith('qrsig=')) || '').split(';')[0].slice(6) || qrsig
    log(`  ptqrshow: HTTP ${r.status}, ${buf.length}B, magic=${buf.slice(0, 4).toString('hex')}`)
    log(`  qrsig=${q2.slice(0, 12)}...  ptqrtoken=${hash33(q2)}`)
    return { loginUrl, qrsig: q2 }
  } catch (e) { log('  ptqrshow 失败:', e.message) }
}

async function probeMvalLogin () {
  log('\n===== 2) login_by_qq（用假凭证验证接口与字段是否被接受）=====')
  const url = 'https://app.mval.qq.com/go/auth/login_by_qq?source_game_zone=agame&game_zone=agame'
  const body = {
    clienttype: 9,
    config_params: { client_dev_name: '23117RK66C', lang_type: 0 },
    login_info: { appid: Number(THIRD_AID), openid: 'PROBE_INVALID_OPENID', qq_info_type: 5, sig: 'PROBE_INVALID_TOKEN', uin: 0 },
    mappid: 10200,
    mcode: MCODE
  }
  try {
    const r = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(T),
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA_MVAL, Cookie: 'clientType=9; openid=null; access_token=null' },
      body: JSON.stringify(body)
    })
    const text = await r.text()
    log(`  HTTP ${r.status}  body: ${text.slice(0, 400)}`)
  } catch (e) { log('  失败:', e.message) }
}

async function probeMAuthorize () {
  log('\n===== 3) m_authorize（WebView 兜底登录页，看是否还活着/什么形态）=====')
  const qs = new URLSearchParams({
    appid: THIRD_AID, scope: 'all', response_type: 'token',
    redirect_uri: 'auth://tauth.qq.com/', display: 'mobile',
    state: 'probe', pf: 'openmobile_android', sdkv: '3.5.17.lite', sdkp: 'a'
  })
  try {
    const r = await fetch(`https://openmobile.qq.com/oauth2.0/m_authorize?${qs}`, {
      signal: AbortSignal.timeout(T),
      headers: { 'User-Agent': UA_MVAL, Accept: 'text/html,*/*;q=0.8', Referer: 'https://openmobile.qq.com/' }
    })
    const html = await r.text()
    log(`  HTTP ${r.status}, ${html.length}B`)
    log(`  location: ${r.headers.get('location') || '(无)'}`)
    const bits = {
      qr: /ptqrshow|qrshow|qrcode/i.test(html),
      mask: /ptuiCB|check_sig|access_token/i.test(html),
      login: /登录|扫码/i.test(html)
    }
    log(`  特征: ${JSON.stringify(bits)}`)
    const snippet = html.replace(/\s+/g, ' ').slice(0, 300)
    log(`  片段: ${snippet}`)
  } catch (e) { log('  失败:', e.message) }
}

await probeQR()
await probeMvalLogin()
await probeMAuthorize()
