import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const AUTH_DIR = join(HERE, 'auth');
export const SHOT_DIR = join(HERE, 'shots');
export const CONFIG_PATH = join(ROOT, 'config', 'sources.json');
export const CODES_PATH = join(ROOT, 'web', 'data', 'codes.json');
export const RESULTS_PATH = join(HERE, 'results.json');
export const WEB_RESULTS_PATH = join(ROOT, 'web', 'data', 'results.js');
export const STATUS_PATH = join(HERE, 'status.json');
export const WEB_STATUS_PATH = join(ROOT, 'web', 'data', 'status.js');

export const PROFILE_DIR = join(HERE, 'profile');

export const authPathFor = id => join(AUTH_DIR, `${id}.json`);
export const profileDirFor = id => join(PROFILE_DIR, id);

export async function loadGames() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  return cfg.games;
}

export async function loadCodes() {
  return JSON.parse(await readFile(CODES_PATH, 'utf8'));
}

/** อ่านอาร์กิวเมนต์แบบ --key=value และ --flag */
export function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v === undefined ? true : v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** โค้ดที่ "ใช้ได้ตอนนี้" ตามช่วงเวลาที่ระบุในชีท */
export function isActive(code, now = new Date()) {
  if (!code.code) return false;
  const start = parseIso(code.start, false);
  const end = parseIso(code.end, true);
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

export function parseIso(iso, endOfDay) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(iso);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  return new Date(
    +m[1], +m[2] - 1, +m[3],
    hasTime ? +m[4] : (endOfDay ? 23 : 0),
    hasTime ? +m[5] : (endOfDay ? 59 : 0)
  );
}

export function todayIso(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------------------------------------------------ อ่านผลจากหน้าเว็บ

/**
 * ข้อความที่หน้าเติมโค้ดมักตอบกลับ ใช้เป็นค่าตั้งต้นเวลายังไม่ได้จูน successText/failText
 * ในคอนฟิก — ถ้าตั้งค่าเองแล้วจะถูกตรวจก่อนรายการเหล่านี้เสมอ
 */
const DEFAULT_USED = [
  'ถูกใช้ไปแล้ว', 'ใช้ไปแล้ว', 'ใช้แล้ว', 'เคยใช้', 'เติมไปแล้ว', 'ซ้ำ',
  'already used', 'already redeemed', 'already claimed', 'has been used', 'duplicate'
];
const DEFAULT_FAIL = [
  'ไม่ถูกต้อง', 'ไม่พบ', 'หมดอายุ', 'ไม่สามารถ', 'ไม่สำเร็จ', 'ผิดพลาด', 'ยังไม่เริ่ม', 'เต็มแล้ว',
  'invalid', 'expired', 'not found', 'incorrect', 'wrong', 'failed', 'error', 'limit'
];
const DEFAULT_PASS = [
  'สำเร็จ', 'เรียบร้อย', 'ได้รับ', 'เติมโค้ดแล้ว', 'ขอบคุณ',
  'success', 'redeemed', 'completed', 'thank you', 'congrat'
];

/**
 * แปลงข้อความตอบกลับเป็นสถานะ
 *   pass    เติมได้ — โค้ดใช้ได้แน่นอน
 *   used    โค้ดถูกใช้ไปแล้ว — แปลว่าโค้ดมีอยู่จริงและใช้ได้ (แค่เติมซ้ำไม่ได้)
 *   fail    เติมไม่ได้ — โค้ดผิด/หมดอายุ/ยังไม่เริ่ม
 *   unknown อ่านผลไม่ออก ต้องดูภาพหน้าจอใน redeem/shots/
 *
 * ตรวจ used ก่อน แล้ว fail แล้วค่อย pass เพราะข้อความอย่าง "ไม่สำเร็จ" มีคำว่า "สำเร็จ" อยู่ข้างใน
 */
export function classify(text, cfg = {}) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  const hit = list => (list || []).some(t => t && low.includes(String(t).toLowerCase()));

  let status = 'unknown';
  if (hit(cfg.usedText) || hit(DEFAULT_USED)) status = 'used';
  else if (hit(cfg.failText) || hit(DEFAULT_FAIL)) status = 'fail';
  else if (hit(cfg.successText) || hit(DEFAULT_PASS)) status = 'pass';

  return { status, message: flat.slice(0, 300) };
}

/** สถานะที่ถือว่า "รู้ผลแล้ว" ไม่ต้องเติมซ้ำในรอบถัดไป */
export const CONCLUSIVE = new Set(['pass', 'used', 'fail']);

export const STATUS_ICON = {
  pass: '✔', used: '◎', fail: '✘', unknown: '?', error: '!', dryrun: '·', skipped: '—'
};

// --------------------------------------------------------------- คลังผลตรวจ

export const resultKey = r => `${r.gameId}|${r.code}`;

/** อ่านผลที่เคยตรวจไว้ (สะสมข้ามวัน ไม่ทับของเดิม) */
export async function loadResults() {
  try {
    const raw = JSON.parse(await readFile(RESULTS_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.results || []);
    return new Map(list.filter(r => r && r.gameId && r.code).map(r => [resultKey(r), r]));
  } catch {
    return new Map();
  }
}

/**
 * เขียนผลลง redeem/results.json และ web/data/results.js
 * ไฟล์ .js ทำให้หน้า dashboard อ่านผลได้เองโดยไม่ต้องกดนำเข้า และเปิดผ่าน file:// ได้
 */
export async function saveResults(map) {
  const results = [...map.values()].sort((a, b) =>
    (a.gameId || '').localeCompare(b.gameId || '') ||
    (a.date || '').localeCompare(b.date || '') ||
    (a.code || '').localeCompare(b.code || ''));

  const payload = { updatedAt: new Date().toISOString(), results };
  await writeFile(RESULTS_PATH, JSON.stringify(payload, null, 2), 'utf8');
  await mkdir(dirname(WEB_RESULTS_PATH), { recursive: true });
  await writeFile(WEB_RESULTS_PATH, `window.CHECK_RESULTS = ${JSON.stringify(payload)};\n`, 'utf8');
  return payload;
}

/**
 * สถานะการรันรอบล่าสุด — ให้ dashboard บอกได้ว่า "ระบบตรวจเองอยู่ปกติ" หรือ
 * "เกมนี้ต้องเข้าไปล็อกอินใหม่" โดยไม่ต้องเปิด log อ่าน
 */
export async function saveRunStatus(status) {
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2), 'utf8');
  await mkdir(dirname(WEB_STATUS_PATH), { recursive: true });
  await writeFile(WEB_STATUS_PATH, `window.CHECK_STATUS = ${JSON.stringify(status)};\n`, 'utf8');
}
