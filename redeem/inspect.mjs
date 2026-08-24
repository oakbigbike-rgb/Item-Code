/**
 * เปิดหน้าเติมโค้ดด้วย session ที่เก็บไว้ แล้วรายงานว่ามีช่องกรอก/ปุ่มอะไรบ้าง
 * ใช้หา selector จริงมาใส่ config/sources.json โดยไม่ต้องเดา
 *
 *   node inspect.mjs warz
 *   node inspect.mjs zone4 --profile     ← เว็บที่มีด่านตรวจบอท ใช้โปรไฟล์ถาวร
 *
 * สคริปต์นี้ไม่กรอกและไม่กดอะไรทั้งนั้น — อ่านโครงหน้าอย่างเดียว
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { loadGames, authPathFor, profileDirFor, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const gameId = args._[0];
const games = await loadGames();
const game = games.find(g => g.id === gameId);

if (!game?.redeem?.url) {
  console.error(`ใช้: node inspect.mjs <gameId> [--profile]\n` +
    `เกมที่ตั้งค่า redeem ไว้: ${games.filter(g => g.redeem?.url).map(g => g.id).join(', ')}`);
  process.exit(1);
}

const authPath = authPathFor(game.id);
if (!args.profile && !existsSync(authPath)) {
  console.error(`ยังไม่มี session ของ ${game.id} — รัน "node login.mjs ${game.id}" ก่อน`);
  process.exit(1);
}

const context = args.profile
  ? await chromium.launchPersistentContext(profileDirFor(game.id), { headless: false, locale: 'th-TH' })
  : await (await chromium.launch({ headless: !args.headed }))
      .newContext({ storageState: authPath, locale: 'th-TH' });

const page = context.pages()[0] || await context.newPage();
await page.goto(game.redeem.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);

const report = await page.evaluate(() => {
  const sel = el => {
    if (el.id) return `#${el.id}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name='${el.name}']`;
    const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return cls.length ? `${el.tagName.toLowerCase()}.${cls.join('.')}` : el.tagName.toLowerCase();
  };
  return {
    url: location.href,
    title: document.title,
    inputs: [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].map(i => ({
      selector: sel(i), type: i.type, name: i.name, placeholder: i.placeholder,
      maxlength: i.getAttribute('maxlength')
    })),
    buttons: [...document.querySelectorAll('button, input[type=submit], a.btn')].map(b => ({
      selector: sel(b), text: (b.innerText || b.value || '').trim().slice(0, 40)
    })).filter(b => b.text),
    bodyStart: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)
  };
});

console.log(`\nหน้า: ${report.title}\nURL : ${report.url}\n`);

if (/passport|login|เข้าสู่ระบบ/i.test(report.title + ' ' + report.url + ' ' + report.bodyStart)) {
  console.log('!! ดูเหมือนโดนเด้งไปหน้าล็อกอิน — session หมดอายุแล้ว รัน login.mjs ใหม่\n');
}

console.log('ช่องกรอก:');
report.inputs.forEach(i => console.log(
  `  ${i.selector.padEnd(34)} type=${i.type} ${i.placeholder ? `placeholder="${i.placeholder}"` : ''} ${i.maxlength ? `maxlength=${i.maxlength}` : ''}`));

console.log('\nปุ่ม:');
report.buttons.forEach(b => console.log(`  ${b.selector.padEnd(34)} "${b.text}"`));

console.log(`\nข้อความบนหน้า: ${report.bodyStart}`);
console.log('\nเอา selector ข้างบนไปใส่ codeInput / submitButton ใน config/sources.json');

await context.close();
process.exit(0);
