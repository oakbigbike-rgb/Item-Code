/**
 * รวมหน้า dashboard ทั้งหมดเป็นไฟล์ HTML ไฟล์เดียว เอาไว้ส่งลิงก์ให้คนอื่นดู
 *
 *   node tools/build-share.mjs                 ← มีโค้ดจริงครบ พร้อมปุ่มคัดลอก (ค่าตั้งต้น)
 *   node tools/build-share.mjs --mask          ← ปิดบังตัวโค้ด ถ้าต้องส่งให้คนนอกทีมดู
 *   node tools/build-share.mjs --lock          ← ใส่รหัสผ่านถึงจะเปิดดูได้ (ถามรหัสตอนรัน)
 *   node tools/build-share.mjs out.html
 *
 * ไฟล์ที่ได้เป็น "สแนปช็อต" — ข้อมูลถูกฝังไว้ ณ ตอนสร้าง เปิดที่ไหนก็ได้ไม่ต้องมีเซิร์ฟเวอร์
 * แต่จะไม่อัปเดตตามชีทอีก ต้องสร้างใหม่ทุกครั้งที่อยากได้ข้อมูลล่าสุด
 *
 * โหมด --mask จะคำนวณผลตรวจ (เดาง่าย/ซ้ำ/โครงเดียวกัน) ไว้ล่วงหน้าด้วย risk.js ตัวเดียวกับหน้าเว็บ
 * แล้วค่อยปิดบังตัวโค้ด ผลบนหน้าจึงยังถูกต้องทั้งที่ไม่มีโค้ดจริงอยู่ในไฟล์เลย
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');
const args = process.argv.slice(2);
const MASK = args.includes('--mask');
const LOCK = args.includes('--lock');
const outArg = args.find(a => !a.startsWith('--'));
const out = resolve(outArg || join(ROOT, 'share',
  LOCK ? 'dashboard-locked.html' : MASK ? 'dashboard-masked.html' : 'dashboard.html'));

const read = p => readFile(join(WEB, p), 'utf8');
// สตริง "</script" ในโค้ดจะไปปิดแท็กก่อนเวลา ต้อง escape ก่อนฝัง
const safe = js => js.replace(/<\/script/gi, '<\\/script');

let html = await read('index.html');

// ---- ฝัง CSS
html = html.replace(/<link rel="stylesheet" href="styles\.css">/,
  `<style>\n${await read('styles.css')}\n</style>`);

// ---- ปิดบังโค้ด: คำนวณผลตรวจไว้ก่อน แล้วค่อยแทนตัวโค้ดด้วยจุด
let maskedCodesJs = null;
let maskStats = null;
if (MASK) maskedCodesJs = await buildMaskedCodes();

// ---- ฝังสคริปต์ทุกไฟล์ตามลำดับเดิม
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)];
for (const [tag, src] of scripts) {
  if (!existsSync(join(WEB, src))) {           // ไฟล์ที่ยังไม่เคยถูกสร้าง เช่น results.js
    html = html.replace(tag, '');
    continue;
  }
  const body = (MASK && src === 'data/codes.js') ? maskedCodesJs : await read(src);
  html = html.replace(tag, `<script>\n${safe(body)}\n</script>`);
}

// ---- บอกให้ app.js รู้ว่าเป็นสแนปช็อต (ปิดการเช็คข้อมูลใหม่ / ซ่อนปุ่มที่ใช้กับโค้ดจริง)
html = html.replace('<script>',
  `<script>window.__SNAPSHOT__ = true; window.__MASKED__ = ${MASK};</script>\n<script>`);

// ---- ชื่อหน้าให้เหมาะกับการส่งต่อ
html = html.replace(/<title>[^<]*<\/title>/, '<title>แดชบอร์ดโค้ดแจกสตรีม</title>');

// ---- ตัดปุ่มที่ทำงานไม่ได้ในหน้าที่แชร์ (ดาวน์โหลด/นำเข้าไฟล์ถูกบล็อก)
html = html
  .replace(/\s*<button id="btnExport"[\s\S]*?<\/button>/, '')
  .replace(/\s*<button id="btnImport"[\s\S]*?<\/button>/, '')
  .replace(/\s*<input type="file" id="fileImport"[^>]*>/, '');

// ---- แถบบอกวันที่ของข้อมูล จะได้ไม่เข้าใจผิดว่าเป็นข้อมูลสด
const data = JSON.parse((await read('data/codes.js'))
  .replace(/^window\.CODES_DATA = /, '').replace(/;\s*$/, ''));
const stamp = (data.generatedAt || '').replace('T', ' ').slice(0, 16);
const total = data.games.reduce((n, g) => n + (g.codes || []).filter(c => c.code).length, 0);

html = html.replace('<main>', `<div class="snapshot-note">
  ภาพนิ่งของหน้าติดตามโค้ด · ข้อมูลจากชีท ณ ${stamp} · รวม ${total} โค้ดจาก ${data.games.length} เกม${
    MASK ? ' · <b>ตัวโค้ดถูกซ่อนไว้</b> ดูโค้ดจริงได้จากหน้าติดตามในเครื่องหรือจากชีทโดยตรง' : ''}
</div>\n<main>`);

html = html.replace('</style>', `
.snapshot-note {
  max-width: 1500px; margin: 14px auto -4px; padding: 8px 20px;
  color: var(--muted); font-size: 12px;
}
</style>`);

// ---- ใส่รหัสผ่าน: เข้ารหัสทั้งหน้า เหลือแค่หน้าถามรหัสไว้ข้างนอก
let lockInfo = null;
if (LOCK) {
  const cred = await askCredentials();
  html = await lockPage(html, secretFrom(cred.id, cred.password));
  lockInfo = { id: cred.id };
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html, 'utf8');

const kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
console.log(`เขียนไฟล์แล้ว: ${out} (${kb} KB)`);
console.log(`ข้อมูล ณ ${stamp} · ${total} โค้ด`);

if (MASK) {
  // กันพลาด: ยืนยันว่าไม่มีโค้ดจริงหลงเหลืออยู่ในไฟล์จริง ๆ
  const leaked = maskStats.codes.filter(c => html.includes(c));
  if (leaked.length) {
    console.error(`\n!! ยังมีโค้ดจริงหลุดอยู่ในไฟล์ ${leaked.length} ตัว เช่น ${leaked.slice(0, 3).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`ปิดบังโค้ดแล้ว ${maskStats.codes.length} ตัว — ตรวจซ้ำแล้วไม่มีโค้ดจริงหลงเหลือในไฟล์`);
    console.log(`ผลตรวจถูกคำนวณไว้ล่วงหน้า: เดาง่าย ${maskStats.high} · ซ้ำในวันเดียวกัน ${maskStats.twins}`);
  }
} else if (lockInfo) {
  console.log(`\nล็อกไฟล์แล้ว — ต้องใส่ ID "${lockInfo.id}" พร้อมรหัสผ่านถึงจะเปิดได้`);
  console.log('ข้อมูลถูกเข้ารหัส AES-256-GCM · เปิดด้วย View Source ก็อ่านไม่ออก');
  console.log('!! ลืม ID หรือรหัส = เปิดไม่ได้อีกเลย ไม่มีทางกู้ ให้สร้างไฟล์ใหม่แทน');
} else {
  console.log('\n!! ไฟล์นี้มีโค้ดจริงครบทุกตัว — ใครเปิดได้ก็ก็อปไปเติมได้');
  console.log('   ระวังเรื่องคนส่งลิงก์ต่อ · ถ้าต้องให้คนนอกทีมดู สร้างแบบปิดบังด้วย --mask หรือใส่รหัสด้วย --lock');
}

// ------------------------------------------------------------------- locking

/**
 * ID ไม่ได้แค่เอาไว้เทียบเฉย ๆ แต่ถูกผสมเข้าไปในกุญแจถอดรหัสด้วย
 * ใส่ ID ผิดก็ถอดไม่ออกเหมือนใส่รหัสผิด — ไม่มีจุดไหนในไฟล์ที่ "เช็คแล้วปล่อยผ่าน"
 * ID ไม่สนตัวพิมพ์เล็กใหญ่ (กันพิมพ์ผิด) ส่วนรหัสผ่านตรงตัวทุกตัวอักษร
 */
function secretFrom(id, pw) {
  return `${String(id).trim().toLowerCase()}\n${pw}`;
}

/** ถาม ID กับรหัสผ่านตอนรัน (หรือรับจาก env เวลาสั่งอัตโนมัติ) */
async function askCredentials() {
  if (process.env.ITEMCODE_PASSWORD) {
    return { id: process.env.ITEMCODE_ID || '', password: process.env.ITEMCODE_PASSWORD };
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const id = (await rl.question('ตั้ง ID สำหรับเปิดไฟล์นี้: ')).trim();
  const pw = (await rl.question('ตั้งรหัสผ่าน: ')).trim();
  const again = (await rl.question('พิมพ์รหัสผ่านอีกครั้ง: ')).trim();
  rl.close();
  if (!id) throw new Error('ไม่ได้ใส่ ID');
  if (!pw) throw new Error('ไม่ได้ใส่รหัสผ่าน');
  if (pw !== again) throw new Error('รหัสผ่านสองครั้งไม่ตรงกัน');
  if (pw.length < 8) console.log('!! รหัสสั้นกว่า 8 ตัว เดาง่าย ควรตั้งให้ยาวกว่านี้');
  return { id, password: pw };
}

/**
 * เข้ารหัสทั้งหน้าเป็นก้อนเดียว แล้วห่อด้วยหน้าถามรหัส
 *
 * ข้อมูลจริงไม่ได้อยู่ในไฟล์ในรูปที่อ่านได้ — เปิดด้วย View Source หรือ F12 ก็เห็นแต่ก้อนที่ถอดไม่ออก
 * ต่างจากหน้าล็อกอินที่เช็ครหัสด้วย JavaScript ซึ่งข้ามได้ในไม่กี่วินาที
 */
async function lockPage(fullHtml, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ITER = 310000;   // ถ่วงเวลาการเดารหัสแบบไล่สุ่ม

  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(fullHtml)));

  const blob = new Uint8Array(salt.length + iv.length + cipher.length);
  blob.set(salt, 0); blob.set(iv, salt.length); blob.set(cipher, salt.length + iv.length);
  const payload = Buffer.from(blob).toString('base64');

  return `<title>แดชบอร์ดโค้ดแจกสตรีม</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0f1115; color: #e6e8ee;
    font: 14px/1.6 "Segoe UI", "Noto Sans Thai", Tahoma, sans-serif;
  }
  .box {
    width: min(92vw, 380px); background: #171a21;
    border: 1px solid #2a2f3a; border-radius: 12px; padding: 26px 24px;
  }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { color: #9aa3b2; font-size: 12.5px; margin: 0 0 18px; }
  label { display: block; font-size: 12px; color: #9aa3b2; margin-bottom: 5px; }
  input {
    width: 100%; box-sizing: border-box; background: #1e222b; color: #e6e8ee;
    border: 1px solid #2a2f3a; border-radius: 7px; padding: 9px 11px; font: inherit;
  }
  input:focus { outline: 2px solid #4da3ff; outline-offset: 1px; border-color: #4da3ff; }
  button {
    width: 100%; margin-top: 12px; background: #4da3ff; color: #07101d;
    border: 0; border-radius: 7px; padding: 10px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: default; }
  .msg { margin-top: 12px; font-size: 12.5px; min-height: 18px; color: #ef5f5f; }
  .msg.working { color: #9aa3b2; }
</style>
<div class="box">
  <h1>เข้าสู่ระบบ</h1>
  <p>ข้อมูลในไฟล์นี้ถูกเข้ารหัสไว้ ใส่ ID และรหัสผ่านให้ถูกจึงจะเปิดดูได้</p>
  <form id="f">
    <label for="uid">ID</label>
    <input type="text" id="uid" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus>
    <label for="pw" style="margin-top:12px">รหัสผ่าน</label>
    <input type="password" id="pw" autocomplete="current-password">
    <button type="submit" id="go">เปิดดูข้อมูล</button>
  </form>
  <div class="msg" id="msg"></div>
</div>
<script>
(function () {
  var PAYLOAD = ${JSON.stringify(payload)};
  var ITER = ${ITER};
  var f = document.getElementById('f'), pw = document.getElementById('pw');
  var uid = document.getElementById('uid');
  var msg = document.getElementById('msg'), go = document.getElementById('go');

  if (!(window.crypto && crypto.subtle)) {
    msg.textContent = 'เบราว์เซอร์นี้เปิดไฟล์เข้ารหัสไม่ได้ ลองเปิดด้วย Chrome หรือ Edge';
    go.disabled = true;
    return;
  }

  f.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    go.disabled = true;
    msg.className = 'msg working';
    msg.textContent = 'กำลังถอดรหัส...';
    try {
      var raw = Uint8Array.from(atob(PAYLOAD), function (c) { return c.charCodeAt(0); });
      var secret = uid.value.trim().toLowerCase() + '\\n' + pw.value;
      var km = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
      var key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: raw.slice(0, 16), iterations: ITER, hash: 'SHA-256' },
        km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, key, raw.slice(28));
      var html = new TextDecoder().decode(plain);
      document.open(); document.write(html); document.close();
    } catch (e) {
      msg.className = 'msg';
      msg.textContent = 'ID หรือรหัสผ่านไม่ถูกต้อง';
      go.disabled = false;
      pw.select();
    }
  });
})();
</script>`;
}

// ------------------------------------------------------------------ masking

/** ปิดบังโค้ด: เหลือหัวสองตัวท้ายสองตัว ที่เหลือเป็นจุด คงตัวคั่นเดิมไว้ */
function maskCode(code) {
  const chars = [...String(code)];
  const idx = chars.map((c, i) => (/[A-Za-z0-9]/.test(c) ? i : -1)).filter(i => i >= 0);
  const keep = new Set([...idx.slice(0, 2), ...idx.slice(-2)]);
  return chars.map((c, i) => (keep.has(i) || !/[A-Za-z0-9]/.test(c) ? c : '•')).join('');
}

async function buildMaskedCodes() {
  // โหลด risk.js ตัวเดียวกับหน้าเว็บ จะได้ไม่มีตรรกะสองสำเนาที่เพี้ยนกันได้
  const sandbox = {};
  new Function('globalThis', await read('risk.js')).call(sandbox, sandbox);
  const CodeRisk = sandbox.CodeRisk;

  const data = JSON.parse((await read('data/codes.js'))
    .replace(/^window\.CODES_DATA = /, '').replace(/;\s*$/, ''));

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const toDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const dayDiff = (a, b) => { const x = toDate(a), y = toDate(b); return x && y ? Math.round((x - y) / 86400000) : null; };
  const fmtDate = iso => { const d = toDate(iso); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '—'; };

  // สร้าง rows แบบเดียวกับที่ app.js ทำ เพื่อให้ผลตรงกันเป๊ะ
  const rows = [];
  data.games.forEach(g => (g.codes || []).forEach((c, i) => {
    rows.push(Object.assign({}, c, { idx: i, gameId: c.gameId || g.id, gameName: c.gameName || g.name, _src: c }));
  }));

  const a = CodeRisk.createAnalyzer(rows, data.games, { todayIso, dayDiff, fmtDate });

  const codes = [...new Set(rows.filter(r => r.code).map(r => r.code))];
  const maskOf = {};
  codes.forEach(c => { maskOf[c] = maskCode(c); });
  // ใช้แทนที่ชื่อโค้ดที่ฝังอยู่ในข้อความเหตุผล เช่น "ต่างจากโค้ด XXXX แค่ 1 ตัว"
  const hide = text => {
    let s = String(text);
    for (const c of codes) {
      if (s.includes(c)) s = s.split(c).join(maskOf[c]);
      const up = CodeRisk.normCode(c);
      if (s.includes(up)) s = s.split(up).join(maskOf[c]);
    }
    return s;
  };

  let high = 0, twins = 0;
  rows.forEach(r => {
    if (!r.code) return;
    const risk = a.riskOf(r);
    if (risk.level) {
      r._src.__risk = { level: risk.level, reasons: risk.reasons.map(hide) };
      high++;
    }
    const rel = a.relativesOf(r);
    if (rel.days.length) {
      const strip = e => ({ code: maskOf[e.raw] || maskCode(e.code), date: e.date });
      r._src.__rel = {
        dup: rel.dup.map(strip), near: rel.near.map(strip),
        family: rel.family.map(strip), days: rel.days
      };
    }
    const t = a.twinsSameDay(r);
    if (t.length) { r._src.__twins = t.map(x => ({ sheet: x.sheet })); twins++; }
  });

  // ปิดบังตัวโค้ดเป็นขั้นสุดท้าย หลังคำนวณทุกอย่างเสร็จแล้ว
  data.games.forEach(g => (g.codes || []).forEach(c => {
    if (c.code) c.code = maskOf[c.code];
  }));

  maskStats = { codes, high, twins };
  return 'window.CODES_DATA = ' + JSON.stringify(data) + ';';
}
