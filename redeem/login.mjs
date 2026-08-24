/**
 * เปิดเบราว์เซอร์ให้ล็อกอินเข้าเว็บเติมโค้ดของเกมด้วยตัวเอง แล้วเก็บ session ไว้ใช้ต่อ
 *
 *   node login.mjs <gameId>
 *   node login.mjs zone4 --profile    ← เว็บที่มีด่านตรวจบอท (Cloudflare) ใช้โปรไฟล์ถาวร
 *
 * สคริปต์ไม่แตะรหัสผ่านเลย — คุณพิมพ์เอง ผ่าน CAPTCHA/OTP/ด่านตรวจบอทเอง
 * เสร็จแล้วกด Enter ในหน้าต่างคำสั่ง ระบบจะเซฟ cookie/localStorage ลง auth/<gameId>.json
 * (โหมด --profile ไม่ต้องเซฟอะไร เพราะเบราว์เซอร์จำไว้ในโฟลเดอร์ profile/<gameId> เอง)
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadGames, AUTH_DIR, authPathFor, profileDirFor, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const gameId = args._[0];
const games = await loadGames();
const game = games.find(g => g.id === gameId);

if (!game) {
  console.error(`ใช้: node login.mjs <gameId> [--profile]\nเกมที่มี: ${games.map(g => g.id).join(', ')}`);
  process.exit(1);
}
if (!game.redeem?.url) {
  console.error(`เกม ${game.id} ยังไม่ได้ตั้งค่า redeem.url ใน config/sources.json`);
  process.exit(1);
}

await mkdir(AUTH_DIR, { recursive: true });

const context = args.profile
  ? await chromium.launchPersistentContext(profileDirFor(game.id), { headless: false, locale: 'th-TH', viewport: null })
  : await (await chromium.launch({ headless: false })).newContext({ locale: 'th-TH' });

const page = context.pages()[0] || await context.newPage();
await page.goto(game.redeem.url, { waitUntil: 'domcontentloaded' });

console.log(`\nเปิดหน้า ${game.redeem.url} แล้ว`);
console.log('ล็อกอินให้เรียบร้อยในหน้าต่างเบราว์เซอร์ (รหัสผ่าน/CAPTCHA/ด่านตรวจบอท ให้คุณทำเอง)');

/**
 * รู้ได้เองว่าล็อกอินเสร็จแล้ว — พอเข้าถึงหน้าเติมโค้ดได้ ช่องกรอกโค้ดจะโผล่มา
 * จะได้ไม่ต้องสลับกลับมากด Enter ที่หน้าต่างคำสั่ง (กด Enter เองก็ยังได้ถ้าอยากรีบ)
 */
const probe = Array.isArray(game.redeem.codeInputs) && game.redeem.codeInputs.length
  ? game.redeem.codeInputs[0] : game.redeem.codeInput;

async function waitUntilLoggedIn() {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      const visible = await p.locator(probe).first()
        .isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) return 'auto';
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return 'timeout';
}

const rl = createInterface({ input: stdin, output: stdout });
const how = await Promise.race([
  rl.question('\nล็อกอินเสร็จแล้วกด Enter (หรือปล่อยไว้ ระบบจะรู้เอง)... ').then(() => 'enter'),
  probe ? waitUntilLoggedIn() : new Promise(() => {})
]);
rl.close();

if (how === 'auto') console.log('ตรวจพบว่าเข้าหน้าเติมโค้ดได้แล้ว — กำลังบันทึก session');
if (how === 'timeout') console.log('รอเกิน 10 นาที — บันทึกเท่าที่มีไว้ก่อน');

if (args.profile) {
  console.log(`เก็บโปรไฟล์ไว้ที่ ${profileDirFor(game.id)}`);
  console.log(`ใช้งานต่อด้วย: node run.mjs --game=${game.id} --profile --commit`);
} else {
  const out = authPathFor(game.id);
  await context.storageState({ path: out });
  console.log(`บันทึก session ไว้ที่ ${out}`);
}
console.log('ไฟล์เหล่านี้อยู่ใน .gitignore แล้ว อย่าแชร์ให้คนอื่น');

await context.close();
process.exit(0);
