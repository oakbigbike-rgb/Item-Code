/**
 * เติมโค้ดผ่านหน้าเว็บของเกม แล้วบันทึกผลว่าโค้ดใช้ได้หรือไม่
 *
 *   node run.mjs                             ← ซ้อมทุกเกมที่ตั้งค่าไว้ (ไม่กดยืนยัน)
 *   node run.mjs --commit                    ← ตรวจจริง ทุกเกม ทุกโค้ดที่ยังไม่เคยตรวจ
 *   node run.mjs --game=cabal-pc --commit --limit=1
 *   node run.mjs --game=warz,talesrunner --commit
 *   node run.mjs --commit --date=today
 *   node run.mjs --commit --recheck          ← ตรวจซ้ำโค้ดที่รู้ผลแล้วด้วย
 *
 * ธงที่ใช้ได้
 *   --commit     กดยืนยันจริง (ไม่ใส่ = โหมดซ้อม ใช้ตรวจว่า selector ถูกไหม)
 *   --headed     เห็นหน้าเบราว์เซอร์ขณะทำงาน
 *   --profile    ใช้โปรไฟล์เบราว์เซอร์ถาวร (redeem/profile/<gameId>) แทน session ไฟล์เดียว
 *                จำเป็นสำหรับเว็บที่มีด่านตรวจบอทของ Cloudflare เช่น Zone4
 *   --game=a,b   เจาะจงเกม (ไม่ใส่ = ทุกเกมที่ตั้งค่า redeem ไว้)
 *   --date=...   เฉพาะโค้ดของวันนั้น (ใส่ today ได้)
 *   --code=XXXX  เฉพาะโค้ดที่ระบุ
 *   --limit=N    จำกัดจำนวนโค้ดต่อเกมต่อรอบ
 *   --all        รวมโค้ดที่ยังไม่เริ่ม/หมดอายุด้วย (ปกติเอาเฉพาะที่ใช้ได้ตอนนี้)
 *   --recheck    ไม่ข้ามโค้ดที่เคยได้ผลชัดเจนแล้ว
 *
 * ผลถูกสะสมไว้ใน redeem/results.json ข้ามวัน และคัดลอกไปที่ web/data/results.js
 * ให้หน้า dashboard อ่านเองอัตโนมัติ
 *
 * !! โค้ดส่วนใหญ่เติมได้ครั้งเดียว — เติมสำเร็จแล้วโค้ดนั้นถูกใช้ไปเลยและคืนไม่ได้
 *    ให้รันด้วยบัญชีทดสอบ และผ่านโหมดซ้อมก่อนใส่ --commit
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadGames, loadCodes, loadResults, saveResults, saveRunStatus, authPathFor, profileDirFor,
  parseArgs, isActive, classify, todayIso, resultKey, CONCLUSIVE, STATUS_ICON, SHOT_DIR
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const wanted = args.game ? String(args.game).split(',').map(s => s.trim()) : null;
const onDate = args.date === true ? null : (args.date === 'today' ? todayIso() : args.date);

const games = await loadGames();
const data = await loadCodes();
const store = await loadResults();

const targets = games.filter(g => g.redeem?.url && (!wanted || wanted.includes(g.id)));

if (!targets.length) {
  const configured = games.filter(g => g.redeem?.url).map(g => g.id);
  console.error(wanted
    ? `ไม่พบเกมที่ตรงกับ --game=${args.game}\nเกมที่ตั้งค่า redeem ไว้แล้ว: ${configured.join(', ') || '(ยังไม่มีเลย)'}`
    : 'ยังไม่มีเกมไหนตั้งค่า redeem ใน config/sources.json เลย');
  process.exit(1);
}

if (!args.commit) {
  console.log('โหมดซ้อม — จะกรอกโค้ดลงฟอร์มแต่ไม่กดยืนยัน (ใส่ --commit เพื่อตรวจจริง)\n');
}

await mkdir(SHOT_DIR, { recursive: true });

// ------------------------------------------------------------------ helpers

/** ข้อความที่ "โผล่ขึ้นมาใหม่" หลังกดยืนยัน — แม่นกว่าการอ่านทั้งหน้า เพราะไม่ติดคำที่มีอยู่เดิม */
function newText(before, after) {
  const old = new Set(before.split('\n').map(s => s.trim()).filter(Boolean));
  return after.split('\n').map(s => s.trim())
    .filter(s => s && !old.has(s)).join(' ');
}

async function readResult(page, cfg) {
  const list = Array.isArray(cfg.resultSelector)
    ? cfg.resultSelector
    : (cfg.resultSelector ? [cfg.resultSelector] : []);
  for (const sel of list) {
    const text = await page.locator(sel).first().innerText({ timeout: 1500 }).catch(() => '');
    if (text && text.trim()) return text;
  }
  return '';
}

const probeName = cfg => (Array.isArray(cfg.codeInputs) && cfg.codeInputs.length)
  ? cfg.codeInputs[0] : cfg.codeInput;

async function fillCode(page, cfg, code) {
  if (Array.isArray(cfg.codeInputs) && cfg.codeInputs.length) {
    const sep = cfg.codeSeparator ?? '-';
    let parts = sep ? code.split(sep) : [];
    if (parts.length !== cfg.codeInputs.length) {
      // โค้ดไม่มีตัวคั่น — หั่นเป็นชิ้นเท่า ๆ กันตามจำนวนช่อง
      const size = Math.ceil(code.replace(/[^A-Za-z0-9]/g, '').length / cfg.codeInputs.length);
      parts = (code.replace(/[^A-Za-z0-9]/g, '').match(new RegExp(`.{1,${size}}`, 'g')) || []);
    }
    if (parts.length !== cfg.codeInputs.length) {
      throw new Error(`โค้ด "${code}" แบ่งเป็น ${cfg.codeInputs.length} ช่องไม่ได้`);
    }
    for (let i = 0; i < cfg.codeInputs.length; i++) {
      await page.fill(cfg.codeInputs[i], parts[i]);
    }
    return;
  }
  await page.fill(cfg.codeInput, code);
}

// --------------------------------------------------------------------- main

const tally = {};
const blocked = [];
const gameStatus = [];
let attempted = 0;
const browser = args.profile ? null : await chromium.launch({ headless: !args.headed });

for (const game of targets) {
  const cfg = game.redeem;
  const bucket = data.games.find(g => g.id === game.id);

  let codes = (bucket?.codes || []).filter(c => c.code);
  if (!args.all) codes = codes.filter(c => isActive(c));
  if (onDate) codes = codes.filter(c => c.date === onDate);
  if (args.code) codes = codes.filter(c => c.code === args.code);

  // โค้ดเดียวกันอาจอยู่หลายแถว (คนละไอเทม) — ตรวจครั้งเดียวพอ
  const seen = new Set();
  codes = codes.filter(c => !seen.has(c.code) && seen.add(c.code));

  const known = codes.filter(c => CONCLUSIVE.has(store.get(`${game.id}|${c.code}`)?.status));
  if (!args.recheck) codes = codes.filter(c => !known.includes(c));
  if (args.limit) codes = codes.slice(0, +args.limit);

  const info = { id: game.id, name: game.name, pending: codes.length, known: known.length, checked: 0, tally: {} };
  gameStatus.push(info);

  console.log(`\n=== ${game.name} — ตรวจ ${codes.length} โค้ด` +
    `${!args.recheck && known.length ? ` (ข้ามที่รู้ผลแล้ว ${known.length})` : ''} ` +
    `${args.commit ? '[ตรวจจริง]' : '[ซ้อม]'} ===`);
  if (!codes.length) { info.state = 'ok'; continue; }

  const authPath = authPathFor(game.id);
  if (cfg.requiresLogin && !args.profile && !existsSync(authPath)) {
    console.log(`  ไม่มี session — รัน "node login.mjs ${game.id}" ก่อน`);
    info.state = 'login';
    info.reason = 'ยังไม่ได้ล็อกอินเก็บ session ไว้';
    info.why = `ยังไม่ได้ล็อกอิน — รัน node login.mjs ${game.id}`;
    blocked.push(`${game.name}: ${info.why}`);
    continue;
  }

  const context = args.profile
    ? await chromium.launchPersistentContext(profileDirFor(game.id), {
        headless: false, locale: 'th-TH', viewport: null
      })
    : await browser.newContext({
        ...(existsSync(authPath) ? { storageState: authPath } : {}),
        locale: 'th-TH'
      });

  const page = context.pages()[0] || await context.newPage();

  // ---- เช็คก่อนลงมือ: ยังล็อกอินอยู่ไหม และหาช่องกรอกโค้ดเจอไหม
  // ถ้า session หมดอายุแล้วปล่อยให้วนต่อ จะได้ error ยาวเป็นพรืดโดยไม่ได้ตรวจอะไรจริง
  const gate = await (async () => {
    try {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: cfg.gotoMs ?? 45000 });
      for (const sel of cfg.dismissSelectors || []) {
        await page.locator(sel).first().click({ timeout: 2000 }).catch(() => {});
      }
      const probe = Array.isArray(cfg.codeInputs) && cfg.codeInputs.length
        ? cfg.codeInputs[0] : cfg.codeInput;
      await page.locator(probe).first().waitFor({ state: 'visible', timeout: 15000 });
      return { ok: true };
    } catch (err) {
      const url = page.url();
      const title = await page.title().catch(() => '');
      const looksLikeLogin = /passport|login|signin|เข้าสู่ระบบ/i.test(url + ' ' + title);
      const challenge = /just a moment|security verification|cloudflare/i.test(title);
      return {
        ok: false,
        state: challenge ? 'challenge' : looksLikeLogin ? 'login' : 'selector',
        reason: challenge ? 'เว็บกันบอทไว้ ต้องผ่านด่านด้วยเบราว์เซอร์จริง'
          : looksLikeLogin ? 'session หมดอายุ ถูกเด้งไปหน้าล็อกอิน'
          : `หาช่องกรอกโค้ดไม่เจอ (${probeName(cfg)})`,
        why: challenge ? 'ติดด่านตรวจบอท — ต้องรันแบบ --profile แล้วผ่านด่านเองครั้งแรก'
          : looksLikeLogin ? `session หมดอายุ — รัน "node login.mjs ${game.id}" ใหม่`
          : `หาช่องกรอกโค้ดไม่เจอ (${probeName(cfg)}) — selector อาจเปลี่ยน ลอง "node inspect.mjs ${game.id}"`
      };
    }
  })();

  if (!gate.ok) {
    console.log(`  ข้าม ${game.name}: ${gate.why}`);
    info.state = gate.state;
    info.reason = gate.reason;
    info.why = gate.why;
    blocked.push(`${game.name}: ${gate.why}`);
    await context.close();
    continue;
  }
  info.state = 'ok';

  let consecutiveErrors = 0;

  for (const entry of codes) {
    const prev = store.get(`${game.id}|${entry.code}`);
    const record = {
      gameId: game.id,
      gameName: game.name,
      code: entry.code,
      date: entry.date,
      sheet: entry.sheet,
      checkedAt: new Date().toISOString(),
      attempts: (prev?.attempts || 0) + 1,
      committed: !!args.commit,
      status: 'unknown',
      message: ''
    };

    try {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: cfg.gotoMs ?? 45000 });

      // ปิดแบนเนอร์คุกกี้/ป็อปอัปที่บังปุ่ม (ตั้งค่าให้กดปุ่มปฏิเสธไว้)
      for (const sel of cfg.dismissSelectors || []) {
        await page.locator(sel).first().click({ timeout: 2000 }).catch(() => {});
      }

      for (const [selector, value] of Object.entries(cfg.extraFields || {})) {
        await page.fill(selector, value);
      }
      await fillCode(page, cfg, entry.code);

      if (!args.commit) {
        record.status = 'dryrun';
        console.log(`  ${STATUS_ICON.dryrun} ${entry.code} — กรอกฟอร์มสำเร็จ`);
        attempted++;
        continue;   // โหมดซ้อมไม่บันทึกทับผลจริงที่เคยได้
      }

      const before = await page.locator('body').innerText().catch(() => '');
      await page.click(cfg.submitButton);
      await page.waitForTimeout(cfg.waitMs ?? 2500);

      let text = await readResult(page, cfg);
      if (!text) {
        const after = await page.locator('body').innerText().catch(() => '');
        text = newText(before, after) || after;
      }

      Object.assign(record, classify(text, cfg));
      if (!record.message) record.message = '(หน้าเว็บไม่ตอบข้อความอะไรกลับมา)';
    } catch (err) {
      record.status = 'error';
      record.message = err.message.split('\n')[0].slice(0, 300);
    }

    // อ่านผลไม่ออก/พัง — เก็บภาพหน้าจอไว้ให้ไล่ดูว่าต้องแก้ selector ตรงไหน
    if (record.status === 'unknown' || record.status === 'error') {
      const shot = join(SHOT_DIR, `${game.id}-${entry.code}.png`.replace(/[^\w.\-]/g, '_'));
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      record.screenshot = shot;
    }

    console.log(`  ${STATUS_ICON[record.status] || '?'} ${entry.code} — ${record.message}`);
    store.set(resultKey(record), record);
    tally[record.status] = (tally[record.status] || 0) + 1;
    info.tally[record.status] = (info.tally[record.status] || 0) + 1;
    info.checked++;
    attempted++;

    // พังติดกันหลายโค้ด = เว็บล่ม/หลุดล็อกอินกลางคัน หยุดเกมนี้ไว้ก่อน ดีกว่าไล่ยิงจนหมด
    consecutiveErrors = record.status === 'error' ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) {
      const why = `พังติดกัน 3 โค้ด (${record.message}) — หยุดเกมนี้ไว้ก่อน`;
      console.log(`  ! ${why}`);
      info.state = 'errors';
      info.reason = `พังติดกัน 3 โค้ด: ${record.message}`.slice(0, 120);
      info.why = why;
      blocked.push(`${game.name}: ${why}`);
      break;
    }

    await page.waitForTimeout(cfg.throttleMs ?? 1200);
  }

  await context.close();
}

if (browser) await browser.close();

await saveRunStatus({
  runAt: new Date().toISOString(),
  mode: args.commit ? 'commit' : 'dry',
  games: gameStatus,
  blocked,
  tally
});

if (args.commit) {
  const payload = await saveResults(store);
  console.log(`\nสรุปรอบนี้: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ') || 'ไม่ได้ตรวจอะไรเลย'}`);
  console.log(`ผลสะสมทั้งหมด ${payload.results.length} โค้ด → redeem/results.json + web/data/results.js`);
  console.log('รีเฟรชหน้า dashboard ได้เลย ผลจะขึ้นเองโดยไม่ต้องกดนำเข้า');
  if (tally.unknown || tally.error) {
    console.log(`มี ${(tally.unknown || 0) + (tally.error || 0)} โค้ดที่อ่านผลไม่ออก — ดูภาพหน้าจอใน redeem/shots/`);
  }
  if (blocked.length) {
    console.log('\nเกมที่ตรวจไม่ได้รอบนี้ (ต้องแก้ก่อน):');
    blocked.forEach(b => console.log(`  ! ${b}`));
    process.exitCode = 2;   // ให้สคริปต์ที่เรียกรู้ว่ามีอะไรต้องเข้าไปดู
  }
} else {
  console.log(`\nโหมดซ้อมจบแล้ว — กรอกฟอร์มได้ ${attempted} โค้ด ยังไม่ได้บันทึกผลอะไร`);
  console.log('ถ้า selector ถูกหมดแล้ว ค่อยรันซ้ำด้วย --commit');
}
