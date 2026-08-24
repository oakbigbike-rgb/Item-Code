/**
 * ตรรกะตรวจ "โค้ดเดาง่าย / ซ้ำ / โครงเดียวกัน"
 *
 * แยกไฟล์ไว้เพราะใช้สองที่ — หน้าเว็บ (app.js) กับตัวสร้างไฟล์แชร์ (tools/build-share.mjs)
 * ที่ต้องคำนวณผลไว้ล่วงหน้าก่อนปิดบังโค้ด ถ้าปล่อยให้มีสองสำเนาไว้จะเพี้ยนกันเมื่อแก้ข้างเดียว
 */
(function (root) {
  'use strict';

  const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

  /** ช่วงยาวสุดที่ตัวอักษรติดกันบนแป้นพิมพ์ และไปทางเดียวกันตลอด */
  function keyboardRun(chars) {
    let best = 1, run = 1, dir = 0;
    for (let i = 1; i < chars.length; i++) {
      const a = chars[i - 1], b = chars[i];
      const row = KEY_ROWS.find(r => r.includes(a) && r.includes(b));
      const gap = row ? row.indexOf(b) - row.indexOf(a) : 0;
      if (row && Math.abs(gap) === 1 && (dir === 0 || Math.sign(gap) === dir)) {
        run++; dir = Math.sign(gap);
      } else { run = 1; dir = 0; }
      if (run > best) best = run;
    }
    return best;
  }

  /** ช่วงยาวสุดที่เรียงต่อกันตามลำดับ เช่น ABCD หรือ 9876 */
  function seqRun(chars) {
    let best = 1, run = 1, dir = 0;
    for (let i = 1; i < chars.length; i++) {
      const d = chars.charCodeAt(i) - chars.charCodeAt(i - 1);
      if ((d === 1 || d === -1) && (dir === 0 || d === dir)) { run++; dir = d; }
      else { run = 1; dir = 0; }
      if (run > best) best = run;
    }
    return best;
  }

  /** ตัวเลขในโค้ดห่างเท่ากันตลอดไหม เช่น 0-3-6-9 (นับแบบวนหลักสิบด้วย) */
  function digitStep(digits) {
    if (digits.length < 4) return null;
    const d = digits.map(Number);
    const step = (d[1] - d[0] + 10) % 10;
    if (step === 0) return null;
    for (let i = 2; i < d.length; i++) {
      if ((d[i] - d[i - 1] + 10) % 10 !== step) return null;
    }
    return step;
  }

  const normCode = c => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const skeletonOf = c => normCode(c).replace(/[0-9]/g, '#');

  function hamming(a, b) {
    if (a.length !== b.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.length && d <= 2; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  /**
   * เกมที่ไม่ต้องตรวจ "โครงโค้ดซ้ำข้ามวัน" และ "โค้ดคล้ายกัน"
   *
   * Talesrunner ยืนยันแล้วว่าโค้ดไม่ได้ออกเป็นซีรีส์ — รูปแบบ คำ + ตัวเลข + ตัวอักษร
   * ทำให้โครงมีโอกาสซ้ำกันเองอยู่แล้ว ไม่ได้แปลว่าผู้เล่นเดาโค้ดวันอื่นออก
   * เอา id ออกจากลิสต์นี้ถ้าอยากให้กลับมาตรวจ
   */
  const SKIP_STRUCTURE_CHECK = new Set(['talesrunner']);

  const RISK_TH = { high: 'เดาง่าย' };

  /**
   * สร้างตัวตรวจสำหรับชุดข้อมูลหนึ่งชุด
   * helpers ต้องมี { todayIso, dayDiff, fmtDate } — ส่งเข้ามาเพื่อไม่ต้องมีตรรกะวันที่ซ้ำสองที่
   */
  function createAnalyzer(rows, games, helpers) {
    const { todayIso, dayDiff, fmtDate } = helpers;

    // ดัชนีโค้ดแยกตามเกม สร้างครั้งเดียว
    const gameIndex = {};
    games.forEach(g => {
      const seen = new Set(), list = [];
      rows.forEach(r => {
        if (r.gameId !== g.id || !r.code) return;
        const k = r.code + '|' + (r.date || '');
        if (seen.has(k)) return;
        seen.add(k);
        list.push({ code: normCode(r.code), raw: r.code, date: r.date || '' });
      });
      const bySkel = {};
      list.forEach(e => (bySkel[skeletonOf(e.code)] = bySkel[skeletonOf(e.code)] || []).push(e));
      gameIndex[g.id] = { list, bySkel };
    });

    /**
     * โค้ดซ้ำกันเองภายในวันเดียวกัน = กรอกพลาด (ก็อปทับช่องข้าง ๆ)
     * วันนั้นจะแจกโค้ดจริงได้น้อยกว่าจำนวนช่องที่เตรียมไว้ ทั้งที่ปฏิทินขึ้นเขียวว่าครบ
     */
    const sameDayIndex = {};
    rows.forEach(r => {
      if (!r.code) return;
      const k = `${r.gameId}|${r.date || ''}|${normCode(r.code)}`;
      (sameDayIndex[k] = sameDayIndex[k] || []).push(r);
    });

    function twinsSameDay(r) {
      if (!r.code) return [];
      const list = sameDayIndex[`${r.gameId}|${r.date || ''}|${normCode(r.code)}`] || [];
      return list.length > 1 ? list.filter(x => x !== r) : [];
    }

    const relCache = {};

    /** โค้ดอื่นของเกมเดียวกันที่ซ้ำ / ต่างกันไม่กี่ตัว / โครงเดียวกัน */
    function relativesOf(r) {
      const empty = { dup: [], near: [], family: [], days: [] };
      if (!r.code) return empty;
      const key = r.gameId + '|' + r.code + '|' + (r.date || '');
      if (relCache[key]) return relCache[key];

      const idx = gameIndex[r.gameId] || { list: [], bySkel: {} };
      const me = normCode(r.code), myDate = r.date || '';

      // โค้ดซ้ำเป๊ะเป็นปัญหาเสมอ จึงตรวจทุกเกม ส่วนโครง/ความคล้ายข้ามได้ตามเกม
      const dup = idx.list.filter(e => e.code === me && e.date !== myDate);
      const skip = SKIP_STRUCTURE_CHECK.has(r.gameId);

      const near = skip ? [] : idx.list.filter(e => e.code !== me && hamming(e.code, me) <= 2);
      // นับเฉพาะพี่น้องที่อยู่คนละวัน — โครงซ้ำภายในวันเดียวกันไม่ช่วยให้เดาวันอื่นออก
      const family = skip ? [] : (idx.bySkel[skeletonOf(me)] || [])
        .filter(e => e.code !== me && e.date !== myDate && !near.some(n => n.code === e.code));

      const days = [...new Set([...dup, ...near, ...family].map(e => e.date).filter(Boolean))].sort();
      return (relCache[key] = { dup, near, family, days });
    }

    const riskCache = {};

    function riskOf(r) {
      if (!r.code) return { level: null, reasons: [] };

      // โค้ดของวันที่ผ่านไปแล้วแก้อะไรไม่ได้ ไม่ต้องเตือนให้รก
      if (r.date && dayDiff(r.date, todayIso) < 0) return { level: null, reasons: [] };

      const cacheKey = r.code + '|' + (r.date || '');
      if (riskCache[cacheKey]) return riskCache[cacheKey];

      const s = String(r.code).toLowerCase().replace(/[^a-z0-9]/g, '');
      const letters = s.replace(/[0-9]/g, '');
      const digits = s.replace(/[^0-9]/g, '').split('');
      const reasons = [];
      let level = null;

      const kb = keyboardRun(letters);
      if (kb >= 5) { reasons.push(`ตัวอักษรไล่ตามแป้นพิมพ์ ${kb} ตัวติดกัน`); level = 'high'; }

      const sq = Math.max(seqRun(letters), seqRun(s.replace(/[^0-9]/g, '')));
      if (sq >= 4) { reasons.push(`เรียงต่อกันเป็นลำดับ ${sq} ตัว`); level = 'high'; }

      const step = digitStep(digits);
      if (step !== null && digits.length >= 5) {
        reasons.push(`ตัวเลขห่างเท่ากันทุกตัว (+${step})`); level = 'high';
      }

      const rel = relativesOf(r);
      if (rel.dup.length) {
        reasons.push(`โค้ดเดียวกันถูกใช้ซ้ำวันที่ ${rel.dup.map(e => fmtDate(e.date)).join(', ')}`);
        level = 'high';
      }
      if (rel.near.length) {
        const n = rel.near[0];
        reasons.push(`ต่างจากโค้ด ${n.code} (${fmtDate(n.date)}) แค่ ${hamming(n.code, normCode(r.code))} ตัว`);
        level = 'high';
      }
      if (rel.family.length) {
        const days = [...new Set(rel.family.map(e => e.date))].sort();
        reasons.push(`โครงเดียวกับโค้ดอีก ${rel.family.length} ตัว ใน ${days.length} วัน (${skeletonOf(r.code)})`);
        level = 'high';
      }

      return (riskCache[cacheKey] = { level, reasons });
    }

    return { riskOf, relativesOf, twinsSameDay, hamming, normCode, skeletonOf };
  }

  root.CodeRisk = { createAnalyzer, RISK_TH, normCode, skeletonOf, hamming };
})(typeof window !== 'undefined' ? window : globalThis);
