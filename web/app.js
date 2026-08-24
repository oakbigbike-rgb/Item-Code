/* Dashboard ตรวจสอบ item code — อ่านข้อมูลจาก window.CODES_DATA (data/codes.js) */

(function () {
  'use strict';

  const DATA = window.CODES_DATA;
  const STORE_KEY = 'itemcode-check-results';
  const PAGE_SIZE = 150;

  if (!DATA || !DATA.games) {
    document.querySelector('main').innerHTML =
      '<div class="panel"><h2>ยังไม่มีข้อมูล</h2>' +
      '<p class="hint">รัน <code>tools\\Update-Codes.ps1</code> ก่อน เพื่อสร้าง <code>web/data/codes.js</code></p></div>';
    return;
  }

  // ---------------------------------------------------------------- utils

  const pad = n => String(n).padStart(2, '0');
  const todayIso = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  /** แปลง "2026-08-16T13:00" เป็น Date ตามเวลาเครื่อง (ไม่ใช่ UTC) */
  function toDate(iso, endOfDayIfNoTime) {
    if (!iso) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(iso);
    if (!m) return null;
    const hasTime = m[4] !== undefined;
    const h = hasTime ? +m[4] : (endOfDayIfNoTime ? 23 : 0);
    const mi = hasTime ? +m[5] : (endOfDayIfNoTime ? 59 : 0);
    return new Date(+m[1], +m[2] - 1, +m[3], h, mi, 0, 0);
  }

  function dayDiff(isoA, isoB) {
    const a = toDate(isoA), b = toDate(isoB);
    if (!a || !b) return null;
    return Math.round((a - b) / 86400000);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = toDate(iso);
    if (!d) return iso;
    const s = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    return /T/.test(iso) ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function addDays(iso, n) {
    const d = toDate(iso);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // -------------------------------------------------------- normalise rows

  const now = new Date();

  /** สร้าง key คงที่ต่อโค้ดหนึ่งรายการ ใช้ผูกกับผลการตรวจสอบที่บันทึกไว้ */
  function rowKey(r) {
    return `${r.gameId}|${r.sheet}|${r.code || '(blank)'}|${r.idx}`;
  }

  const rows = [];
  DATA.games.forEach(g => {
    (g.codes || []).forEach((c, i) => {
      const r = Object.assign({}, c);
      r.idx = i;
      r.gameId = r.gameId || g.id;
      r.gameName = r.gameName || g.name;
      r.startAt = toDate(r.start, false);
      r.endAt = toDate(r.end, true);

      if (!r.code) r.status = 'missing';
      else if (r.startAt && now < r.startAt) r.status = 'upcoming';
      else if (r.endAt && now > r.endAt) r.status = 'expired';
      else r.status = 'active';

      r.key = rowKey(r);
      rows.push(r);
    });
  });

  // -------------------------------------------- ความเสี่ยงว่าผู้เล่นจะเดาโค้ดได้

  /**
   * ตรรกะทั้งหมดอยู่ใน risk.js เพราะตัวสร้างไฟล์แชร์ต้องใช้ชุดเดียวกัน
   * ไฟล์แชร์แบบปิดบังโค้ดจะคำนวณผลไว้ล่วงหน้าแล้วฝังมาในแต่ละแถว (__risk / __rel / __twins)
   * ตรงนี้จึงหยิบของที่ฝังมาก่อน ถ้าไม่มีค่อยคำนวณเองจากโค้ดจริง
   */
  const RISK_TH = window.CodeRisk.RISK_TH;
  const normCode = window.CodeRisk.normCode;
  const hamming = window.CodeRisk.hamming;
  const analyzer = window.CodeRisk.createAnalyzer(rows, DATA.games, { todayIso, dayDiff, fmtDate });

  const riskOf = r => r.__risk || analyzer.riskOf(r);
  const relativesOf = r => r.__rel || analyzer.relativesOf(r);
  const twinsSameDay = r => r.__twins || analyzer.twinsSameDay(r);


  /** หน้าเติมโค้ดของแต่ละเกม (มาจาก config/sources.json ที่ฝังไว้ตอนดึงชีท) */
  const REDEEM_URL = {};
  DATA.games.forEach(g => { if (g.redeem && g.redeem.url) REDEEM_URL[g.id] = g.redeem.url; });

  // --------------------------------------------------------- check results

  /**
   * ผลตรวจมาจากสองทาง
   *   auto   — redeem runner เขียนไว้ใน data/results.js (ผูกกับโค้ด ไม่ใช่กับแถว)
   *   manual — ที่กดบันทึกเองในหน้านี้ เก็บใน localStorage และทับผลอัตโนมัติเสมอ
   */
  const RESULT_TH = {
    pass: '✔ เติมได้',
    used: '◎ ใช้ได้ (ถูกใช้ไปแล้ว)',
    fail: '✘ เติมไม่ได้',
    unknown: '? อ่านผลไม่ออก',
    error: '! ตรวจไม่สำเร็จ'
  };
  const OK_STATUS = new Set(['pass', 'used']);   // โค้ดใช้ได้จริง

  let manual = {};
  try { manual = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { manual = {}; }
  const saveResults = () => localStorage.setItem(STORE_KEY, JSON.stringify(manual));

  const auto = {};
  const autoPayload = window.CHECK_RESULTS || {};
  (autoPayload.results || []).forEach(item => {
    if (!item || !item.code) return;
    rows.filter(r => r.gameId === item.gameId && r.code === item.code).forEach(r => {
      auto[r.key] = {
        status: RESULT_TH[item.status] ? item.status : 'unknown',
        note: item.message || '',
        at: (item.checkedAt || '').replace('T', ' ').slice(0, 16),
        source: 'redeem-runner'
      };
    });
  });

  const resultOf = key => manual[key] || auto[key] || null;

  // ------------------------------------------------------- coverage per game

  /** ค่าที่พบบ่อยที่สุดในชุดตัวเลข — เสมอกันให้เลือกค่ามาก (bigger) หรือค่าน้อย */
  function modeOf(values, bigger) {
    const freq = {};
    values.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
    const keys = Object.keys(freq);
    if (!keys.length) return 0;
    return +keys.reduce((a, b) => {
      if (freq[b] !== freq[a]) return freq[b] > freq[a] ? b : a;
      return (bigger ? +b > +a : +b < +a) ? b : a;
    });
  }

  /**
   * ความครอบคลุมของโค้ดต่อเกม
   *
   * ชีทแต่ละวันเตรียม "ช่อง" สำหรับกรอกโค้ดไว้ล่วงหน้า (เช่น Talesrunner วันละ 12 ช่อง)
   * จำนวนที่ควรมีต่อวันจึงต้องอ่านจากจำนวนช่องในชีทจริง ไม่ใช่จากจำนวนโค้ดที่กรอกแล้ว
   * ถ้าดูจากโค้ดที่กรอกแล้วอย่างเดียว วันที่กรอกไปแค่ 1 จาก 12 จะกลายเป็น "ปกติ" ทันที
   * ที่วันแบบนั้นมีมากกว่าวันที่กรอกครบ แล้วปฏิทินจะขึ้นเขียวทั้งที่ยังขาดอีก 11 โค้ด
   *
   * Cabal PC ลงโค้ดเฉพาะวันคู่ ส่วน Cabal M ลงวันคี่ ถ้านับทุกวันที่ว่างเป็น "ขาดโค้ด"
   * จะเตือนผิดครึ่งหนึ่งของปฏิทิน จึงหาว่าเกมนี้ลงโค้ดทุกกี่วันจากข้อมูลจริงก่อน
   * แล้วค่อยถือว่าวันที่หลุดจากรอบนั้นคือวันที่ขาด
   */
  function coverageOf(gameId) {
    const mine = rows.filter(r => r.gameId === gameId && r.date);

    const slots = {};   // วันที่ -> จำนวนช่องที่ชีทเตรียมไว้
    const perDay = {};  // วันที่ -> จำนวนช่องที่กรอกโค้ดแล้ว
    mine.forEach(r => {
      slots[r.date] = (slots[r.date] || 0) + 1;
      perDay[r.date] = (perDay[r.date] || 0) + (r.code ? 1 : 0);
    });

    const dates = Object.keys(slots).sort();
    if (!dates.length) {
      return {
        dates: [], slots, perDay, cadence: 1, typical: 0, expected: () => 0,
        partial: [], blank: [], gaps: [], gapSet: new Set(),
        first: null, last: null, lastFilled: null, lastFull: null,
        count: 0, blankSlots: 0
      };
    }

    // รอบการลงโค้ด — เสมอกันเลือกรอบสั้นกว่าไว้ก่อน จะได้ไม่มองข้ามวันที่ขาด
    const cadence = dates.length > 1
      ? Math.max(1, modeOf(dates.slice(1).map((d, i) => dayDiff(d, dates[i])), false))
      : 1;

    // จำนวนช่องต่อวันตามปกติของเกมนี้ — วันไหนชีทเตรียมช่องไว้น้อยกว่าปกติก็ยังถือว่าไม่ครบ
    const typical = modeOf(dates.map(d => slots[d]), true);
    const expected = d => Math.max(slots[d] || 0, typical);

    const partial = dates.filter(d => perDay[d] > 0 && perDay[d] < expected(d));
    const blank = dates.filter(d => !perDay[d]);                 // มีชีทแล้วแต่ยังไม่ใส่โค้ดเลย
    const filledDates = dates.filter(d => perDay[d] > 0);
    const fullDates = dates.filter(d => perDay[d] >= expected(d));

    // วันที่หลุดรอบ: ควรมีตามรอบแต่ไม่มีชีทของวันนั้นเลย
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i], dates[i - 1]) <= cadence) continue;
      for (let d = addDays(dates[i - 1], cadence); dayDiff(dates[i], d) > 0; d = addDays(d, cadence)) {
        gaps.push(d);
      }
    }
    // เลยวันสุดท้ายที่เตรียมไว้มาแล้ว = หยุดเตรียมโค้ดไปตั้งแต่วันนั้น
    const last = dates[dates.length - 1];
    if (dayDiff(todayIso, last) > 0) {
      for (let d = addDays(last, cadence); dayDiff(todayIso, d) >= 0; d = addDays(d, cadence)) {
        gaps.push(d);
      }
    }

    let blankSlots = 0;
    dates.forEach(d => { blankSlots += slots[d] - (perDay[d] || 0); });

    return {
      dates, slots, perDay, cadence, typical, expected,
      partial, blank, gaps, gapSet: new Set(gaps),
      first: dates[0],
      last,
      lastFilled: filledDates.length ? filledDates[filledDates.length - 1] : null,
      lastFull: fullDates.length ? fullDates[fullDates.length - 1] : null,
      count: mine.filter(r => r.code).length,
      blankSlots
    };
  }

  /** สถานะของช่องปฏิทินหนึ่งวัน — ใช้ทั้งในปฏิทินและการ์ดสรุป */
  function dayState(cov, d) {
    const slots = cov.slots[d];
    const filled = cov.perDay[d] || 0;

    if (slots === undefined) {
      if (cov.gapSet.has(d)) return { cls: 'none', label: '–', tip: 'ขาดโค้ด — ยังไม่มีชีทของวันนี้' };
      if (cov.last && dayDiff(d, cov.last) > 0) return { cls: 'idle', label: '–', tip: 'ยังไม่ได้เตรียมโค้ด' };
      return { cls: 'idle', label: '–', tip: 'ไม่ใช่วันลงโค้ด' };
    }

    const exp = cov.expected(d);
    if (!filled) {
      return { cls: 'none', label: `0/${exp}`, frac: true, filled, exp, tip: `มีชีทแล้วแต่ยังไม่ได้ใส่โค้ดเลย (0 จาก ${exp})` };
    }
    if (filled < exp) {
      return { cls: 'part', label: `${filled}/${exp}`, frac: true, filled, exp, tip: `กรอกแล้ว ${filled} จาก ${exp} โค้ด — ยังขาดอีก ${exp - filled}` };
    }
    return { cls: 'has', label: String(filled), filled, exp, tip: `${filled} โค้ด ครบตามปกติของเกมนี้` };
  }

  const coverage = {};
  DATA.games.forEach(g => { coverage[g.id] = coverageOf(g.id); });

  // ---------------------------------------------------------- summary card

  function buildSummary() {
    const host = document.getElementById('summary');
    host.innerHTML = '';

    DATA.games.forEach(game => {
      const mine = rows.filter(r => r.gameId === game.id);
      const withCode = mine.filter(r => r.code);
      const cov = coverage[game.id];

      // "เตรียมโค้ดไว้ถึงวันไหน" ต้องนับเฉพาะวันที่กรอกครบ วันที่กรอกไปแค่บางส่วนยังใช้จริงไม่ได้
      const upcoming = d => dayDiff(d, todayIso) >= 0;
      const fullTo = cov.lastFull;
      const remaining = fullTo ? dayDiff(fullTo, todayIso) : null;
      const gaps = cov.gaps.filter(upcoming);
      const partial = cov.partial.filter(upcoming);
      const blank = cov.blank.filter(upcoming);
      const missingSoon = partial.concat(blank).sort()
        .reduce((sum, d) => sum + (cov.expected(d) - (cov.perDay[d] || 0)), 0);

      const activeNow = mine.filter(r => r.status === 'active').length;

      // นับโค้ดเดาง่ายเฉพาะวันนี้เป็นต้นไป โดยไม่นับซ้ำถ้าโค้ดเดียวกันอยู่หลายแถว
      const seenCode = new Set();
      const risky = [];
      const riskyDays = {};
      withCode.forEach(r => {
        if (seenCode.has(r.code)) return;
        seenCode.add(r.code);
        if (riskOf(r).level !== 'high') return;
        risky.push(r.code);
        const d = r.date || '';
        riskyDays[d] = (riskyDays[d] || 0) + 1;
      });

      // โค้ดที่ถูกใส่ซ้ำในวันเดียวกัน — นับ "จำนวนช่องที่เสียไป" ต่อวัน
      const dupSeen = new Set();
      const dupDays = {};
      let dupLost = 0;
      withCode.forEach(r => {
        if (r.date && dayDiff(r.date, todayIso) < 0) return;
        const k = `${r.date || ''}|${normCode(r.code)}`;
        if (dupSeen.has(k)) return;
        const twins = twinsSameDay(r);
        if (!twins.length) return;
        dupSeen.add(k);
        const d = r.date || '';
        dupDays[d] = (dupDays[d] || 0) + 1;
        dupLost += twins.length;      // ช่องที่ควรเป็นโค้ดใหม่แต่กลายเป็นของซ้ำ
      });

      /** วันที่กดได้ กดแล้วกรองตารางเหลือเฉพาะโค้ดเสี่ยงของเกม+วันนั้น */
      const dayLinks = (byDate, max, risk) => {
        const days = Object.keys(byDate).filter(Boolean).sort();
        const shown = days.slice(0, max).map(d =>
          `<button class="daylink" data-game="${esc(game.id)}" data-date="${d}" data-risk="${risk || ''}"
             title="ดูโค้ดของวันนี้">${fmtDate(d)} <b>${byDate[d]}</b></button>`).join('');
        return { count: days.length, html: shown + (days.length > max ? ' <span class="to">…</span>' : '') };
      };

      let cls = 'good';
      if (remaining === null || remaining < 0 || gaps.length || blank.length) cls = 'bad';
      else if (remaining <= 2 || partial.length) cls = 'warn';

      const listDays = (days, n) => days.slice(0, n)
        .map(d => `${fmtDate(d)} <b>${cov.perDay[d] || 0}/${cov.expected(d)}</b>`)
        .join(', ') + (days.length > n ? ' …' : '');

      const card = document.createElement('div');
      card.className = `card ${cls}`;
      card.innerHTML = `
        <h3>${esc(game.name)}
          <span class="links">
            <a href="${esc(game.docUrl)}" target="_blank" rel="noopener">ชีท ↗</a>
            ${REDEEM_URL[game.id]
              ? `<a href="${esc(REDEEM_URL[game.id])}" target="_blank" rel="noopener">หน้าเติมโค้ด ↗</a>`
              : ''}
          </span>
        </h3>
        <div class="until">กรอกโค้ดครบถึง <b>${fullTo ? fmtDate(fullTo) : 'ยังไม่มีวันที่ครบเลย'}</b></div>
        <div class="days">${
          remaining === null ? 'ยังไม่พบโค้ดในชีท'
            : remaining < 0 ? `เลยวันที่เตรียมไว้มา ${-remaining} วันแล้ว`
            : remaining === 0 ? 'มีโค้ดถึงแค่วันนี้ พรุ่งนี้ยังไม่มี'
            : `ใช้ได้อีก ${remaining} วัน`
        }${cov.cadence > 1 ? ` · ลงโค้ดทุก ${cov.cadence} วัน` : ''}</div>
        ${cov.last && (!fullTo || dayDiff(cov.last, fullTo) > 0)
          ? `<div class="days">ชีทเตรียมไว้ถึง ${fmtDate(cov.last)} แต่ยังกรอกไม่ครบ</div>` : ''}
        <dl>
          <dt>โค้ดที่กรอกแล้ว</dt><dd>${withCode.length} / ${mine.length}</dd>
          <dt>ใช้ได้ตอนนี้</dt><dd>${activeNow}</dd>
          <dt>ช่องว่างที่ยังไม่กรอก</dt><dd>${
            (mine.length - withCode.length)
              ? `<span style="color:var(--warn)">${mine.length - withCode.length}</span>`
              : '0'}</dd>
        </dl>
        ${Object.keys(dupDays).length ? (() => {
          const d = dayLinks(dupDays, 12);
          return `<div class="alert bad">ใส่โค้ดตัวเดียวกันซ้ำ ${d.count === 1 ? 'ในวันที่' : `${d.count} วัน`} — ต้องหาโค้ดมาเติมอีก ${dupLost} ตัว
                  <span class="days-list">${d.html}</span></div>`;
        })() : ''}
        ${risky.length ? (() => {
          const d = dayLinks(riskyDays, 12, 'high');
          return `<div class="alert bad">โค้ด ${risky.length} ตัวเดาได้ ควรเปลี่ยนก่อนถึงวันแจก
                  <span class="days-list">${d.html}</span></div>`;
        })() : ''}
        ${gaps.length ? `<div class="alert bad">${
          gaps.length === 1 ? `วันที่ ${fmtDate(gaps[0])} ยังไม่มีโค้ดเลย`
            : `${gaps.length} วันนี้ยังไม่มีโค้ดเลย: ${gaps.slice(0, 5).map(fmtDate).join(', ')}${gaps.length > 5 ? ' …' : ''}`
        }</div>` : ''}
        ${blank.length ? `<div class="alert bad">เตรียมชีทไว้แล้วแต่ยังไม่ได้ใส่โค้ด ${blank.length} วัน: ${listDays(blank, 4)}</div>` : ''}
        ${partial.length ? `<div class="alert">ใส่โค้ดยังไม่ครบ ${partial.length} วัน (ปกติวันละ ${cov.typical} ตัว): ${listDays(partial, 4)}</div>` : ''}
        ${missingSoon ? `<div class="alert">รวมแล้วยังต้องหาโค้ดมาใส่อีก ${missingSoon} ตัว</div>` : ''}
        ${remaining !== null && remaining >= 0 && remaining <= 2 ? '<div class="alert">โค้ดที่เตรียมไว้ใกล้หมดแล้ว ควรเตรียมของวันถัดไป</div>' : ''}
        ${(game.errors || []).length ? `<div class="alert bad">เปิดชีทไม่ได้ ${game.errors.length} แผ่น ข้อมูลอาจไม่ครบ</div>` : ''}
        ${game.redeem ? '' : '<div class="alert">ยังไม่ได้ตั้งค่าหน้าเติมโค้ดของเกมนี้ จึงยังตรวจโค้ดอัตโนมัติไม่ได้</div>'}
      `;
      host.appendChild(card);
    });

    // กดวันที่บนการ์ด = กรองตารางเหลือเฉพาะโค้ดเสี่ยงของเกม+วันนั้น
    host.onclick = ev => {
      const btn = ev.target.closest('.daylink');
      if (!btn) return;
      el.game.value = btn.dataset.game;
      el.from.value = btn.dataset.date;
      el.to.value = btn.dataset.date;
      el.risk.value = btn.dataset.risk || '';
      el.status.value = '';
      el.result.value = '';
      el.search.value = '';
      shown = PAGE_SIZE;
      render();
      document.getElementById('codeTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  // -------------------------------------------------------------- calendar

  function buildCalendar() {
    const host = document.getElementById('calendar');
    host.innerHTML = '';

    // ช่วงวันที่ที่จะแสดง: ตั้งแต่ 3 วันก่อนวันนี้ ถึงวันสุดท้ายที่มีโค้ดของทุกเกม
    const allDates = rows.filter(r => r.date).map(r => r.date).sort();
    if (!allDates.length) return;
    const from = addDays(todayIso, -3);
    let to = allDates[allDates.length - 1];
    if (dayDiff(to, from) < 0) to = from;
    if (dayDiff(to, from) > 60) to = addDays(from, 60);

    DATA.games.forEach(game => {
      const cov = coverage[game.id];

      const days = [];
      for (let d = from; dayDiff(to, d) >= 0; d = addDays(d, 1)) {
        const dd = toDate(d);
        // เขียว = ครบ · เหลือง = มีแต่ไม่ครบ · แดง = ควรมีแต่ขาด · เทา = ไม่ใช่วันลงโค้ด
        const st = dayState(cov, d);

        const pick = cov.slots[d] !== undefined
          ? ` data-game="${esc(game.id)}" data-date="${d}"` : '';

        days.push(
          `<div class="cal-day ${st.cls} ${d === todayIso ? 'today' : ''}${pick ? ' pick' : ''}"${pick}` +
          ` title="${fmtDate(d)} — ${st.tip}${pick ? ' (คลิกเพื่อดูรายการของวันนี้)' : ''}">` +
          `<span class="d">${pad(dd.getDate())}/${pad(dd.getMonth() + 1)}</span>` +
          `<span class="n${st.frac ? ' frac' : ''}">${st.label}</span></div>`
        );
      }

      const row = document.createElement('div');
      row.className = 'cal-row';
      row.innerHTML =
        `<div class="cal-name">${esc(game.name)}` +
        `<span class="cal-sub">${cov.lastFull ? 'ครบถึง ' + fmtDate(cov.lastFull) : '—'}</span></div>` +
        `<div class="cal-days">${days.join('')}</div>`;
      host.appendChild(row);
    });

    // คลิกช่องปฏิทิน = กรองตารางด้านล่างให้เหลือเฉพาะเกม+วันนั้น
    host.addEventListener('click', ev => {
      const cell = ev.target.closest('.cal-day.pick');
      if (!cell) return;
      el.game.value = cell.dataset.game;
      el.from.value = cell.dataset.date;
      el.to.value = cell.dataset.date;
      el.status.value = '';
      el.result.value = '';
      el.search.value = '';
      shown = PAGE_SIZE;
      render();
      document.getElementById('codeTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ------------------------------------------------------- ปฏิทินผลตรวจโค้ด

  /** ตรวจโค้ดของวันนั้นไปแล้วแค่ไหน และผลออกมาใช้ได้จริงไหม */
  function buildCheckCalendar() {
    const host = document.getElementById('checkCalendar');
    host.innerHTML = '';

    const stamp = document.getElementById('checkStamp');
    stamp.textContent = autoPayload.updatedAt
      ? `runner ตรวจล่าสุด ${autoPayload.updatedAt.replace('T', ' ').slice(0, 16)}`
      : 'ยังไม่เคยรัน redeem runner — ผลที่เห็นมาจากที่บันทึกเองเท่านั้น';

    const allDates = rows.filter(r => r.date).map(r => r.date).sort();
    if (!allDates.length) return;
    const from = addDays(todayIso, -14);
    let to = allDates[allDates.length - 1];
    if (dayDiff(to, from) < 0) to = from;
    if (dayDiff(to, from) > 60) to = addDays(from, 60);

    DATA.games.forEach(game => {
      const byDate = {};
      rows.filter(r => r.gameId === game.id && r.code && r.date)
        .forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });

      let okAll = 0, badAll = 0, doneAll = 0, totalAll = 0;
      const days = [];

      for (let d = from; dayDiff(to, d) >= 0; d = addDays(d, 1)) {
        const dd = toDate(d);
        const list = byDate[d] || [];
        const res = list.map(r => resultOf(r.key)).filter(Boolean);
        const ok = res.filter(x => OK_STATUS.has(x.status)).length;
        const bad = res.filter(x => x.status === 'fail').length;
        const odd = res.length - ok - bad;

        totalAll += list.length; doneAll += res.length; okAll += ok; badAll += bad;

        let cls = 'idle', label = '–', frac = false;
        let tip = list.length ? `มี ${list.length} โค้ด · ยังไม่ได้ตรวจ` : 'ไม่มีโค้ดของวันนี้';

        if (list.length && res.length) {
          label = `${res.length}/${list.length}`;
          frac = true;
          if (bad) { cls = 'none'; tip = `เติมไม่ได้ ${bad} จากที่ตรวจ ${res.length}/${list.length}`; }
          else if (odd || res.length < list.length) {
            cls = 'part';
            tip = `ตรวจแล้ว ${res.length}/${list.length}` + (odd ? ` · ต้องดูเอง ${odd}` : '');
          } else { cls = 'has'; tip = `ตรวจครบ ${list.length} โค้ด ใช้ได้ทั้งหมด`; }
        }

        const pick = list.length ? ` data-game="${esc(game.id)}" data-date="${d}"` : '';
        days.push(
          `<div class="cal-day ${cls} ${d === todayIso ? 'today' : ''}${pick ? ' pick' : ''}"${pick}` +
          ` title="${fmtDate(d)} — ${tip}">` +
          `<span class="d">${pad(dd.getDate())}/${pad(dd.getMonth() + 1)}</span>` +
          `<span class="n${frac ? ' frac' : ''}">${label}</span></div>`
        );
      }

      const sub = totalAll
        ? `ตรวจ ${doneAll}/${totalAll}` + (badAll ? ` · เสีย ${badAll}` : '')
        : '—';

      const row = document.createElement('div');
      row.className = 'cal-row';
      row.innerHTML =
        `<div class="cal-name">${esc(game.name)}<span class="cal-sub">${sub}</span></div>` +
        `<div class="cal-days">${days.join('')}</div>`;
      host.appendChild(row);
    });

    host.addEventListener('click', ev => {
      const cell = ev.target.closest('.cal-day.pick');
      if (!cell) return;
      el.game.value = cell.dataset.game;
      el.from.value = cell.dataset.date;
      el.to.value = cell.dataset.date;
      el.status.value = '';
      el.result.value = '';
      el.search.value = '';
      shown = PAGE_SIZE;
      render();
      document.getElementById('codeTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ----------------------------------------------------------------- table

  const el = {
    game: document.getElementById('fGame'),
    status: document.getElementById('fStatus'),
    result: document.getElementById('fResult'),
    risk: document.getElementById('fRisk'),
    from: document.getElementById('fFrom'),
    to: document.getElementById('fTo'),
    search: document.getElementById('fSearch'),
    tbody: document.querySelector('#codeTable tbody'),
    info: document.getElementById('tableInfo'),
    more: document.getElementById('btnMore')
  };

  DATA.games.forEach(g => {
    const o = document.createElement('option');
    o.value = g.id; o.textContent = g.name;
    el.game.appendChild(o);
  });

  let shown = PAGE_SIZE;

  function filtered() {
    const q = el.search.value.trim().toLowerCase();
    return rows.filter(r => {
      if (el.game.value && r.gameId !== el.game.value) return false;
      if (el.status.value && r.status !== el.status.value) return false;
      if (el.from.value && (!r.date || r.date < el.from.value)) return false;
      if (el.to.value && (!r.date || r.date > el.to.value)) return false;
      if (el.result.value) {
        const got = resultOf(r.key);
        if (el.result.value === 'none') { if (got) return false; }
        else if (el.result.value === 'ok') { if (!got || !OK_STATUS.has(got.status)) return false; }
        else if (!got || got.status !== el.result.value) return false;
      }
      if (el.risk.value) {
        const lv = riskOf(r).level;
        if (el.risk.value === 'none' ? !!lv : lv !== el.risk.value) return false;
      }
      if (q) {
        const hay = [r.code, r.sheet, r.gameName, (r.items || []).map(i => i.name).join(' ')]
          .join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (a.date || '').localeCompare(b.date || '') ||
                      a.gameName.localeCompare(b.gameName));
  }

  const STATUS_TH = { active: 'ใช้ได้ตอนนี้', upcoming: 'ยังไม่เริ่ม', expired: 'หมดอายุแล้ว', missing: 'ยังไม่มีโค้ด' };

  function render() {
    const list = filtered();
    const page = list.slice(0, shown);

    el.tbody.innerHTML = page.map(r => {
      const res = resultOf(r.key);
      const items = (r.items || []).slice(0, 4)
        .map(i => `<b>${esc(i.name)}</b>${i.amount ? ` ×${esc(i.amount)}` : ''}`).join(', ');
      const extra = (r.items || []).length > 4 ? ` +${r.items.length - 4}` : '';

      return `<tr data-key="${esc(r.key)}">
        <td>${esc(r.gameName)}</td>
        <td class="range">${fmtDate(r.date)}<br><span class="to">${esc(r.sheet)}</span></td>
        <td>${r.code
            ? `<code class="codeval${window.__MASKED__ ? ' masked' : ''}">${esc(r.code)}</code>${(() => {
                 const twins = twinsSameDay(r);
                 if (!twins.length) return '';
                 const where = twins.map(t => t.sheet).filter(Boolean);
                 return ` <span class="risk dup" title="${esc(`โค้ดนี้ถูกใส่ซ้ำ ${twins.length + 1} ช่องในวันเดียวกัน` +
                   (where.length ? ` (ชีท ${[...new Set(where)].join(', ')})` : '') +
                   ' — วันนั้นจะได้โค้ดจริงน้อยกว่าที่เตรียมไว้')}">ซ้ำในวันเดียวกัน</span>`;
               })()}${(() => {
                 const risk = riskOf(r);
                 return risk.level
                   ? ` <span class="risk ${risk.level}" title="${esc(risk.reasons.join(' · '))}">${RISK_TH[risk.level]}</span>`
                   : '';
               })()}${(() => {
                 // คล้าย/ซ้ำกับโค้ดวันไหนบ้าง — ไว้ไล่ตรวจข้ามวันได้เร็ว
                 // แถวของวันที่ผ่านไปแล้วไม่ต้องบอก แต่ยังชี้ไปวันเก่าได้ (โครงที่หลุดไปแล้ว)
                 if (r.date && dayDiff(r.date, todayIso) < 0) return '';
                 const rel = relativesOf(r);
                 if (!rel.days.length) return '';
                 const detail = [
                   ...rel.dup.map(e => `ซ้ำเป๊ะ ${e.code} (${fmtDate(e.date)})`),
                   ...rel.near.map(e => `ต่าง ${hamming(e.code, normCode(r.code))} ตัว: ${e.code} (${fmtDate(e.date)})`),
                   ...rel.family.slice(0, 8).map(e => `โครงเดียวกัน: ${e.code} (${fmtDate(e.date)})`)
                 ];
                 const label = rel.dup.length ? 'ซ้ำกับ' : rel.near.length ? 'คล้ายกับ' : 'โครงเดียวกับ';
                 return `<div class="twin" title="${esc(detail.join('\n'))}">${label} ` +
                   rel.days.slice(0, 5).map(d =>
                     `<button class="daylink" data-game="${esc(r.gameId)}" data-date="${d}"
                        data-code="${esc(r.code)}">${fmtDate(d)}</button>`).join('') +
                   (rel.days.length > 5 ? ` <span class="to">+${rel.days.length - 5}</span>` : '') + '</div>';
               })()}
               ${window.__MASKED__
                 // ไฟล์ที่แชร์ไม่มีโค้ดจริงอยู่แล้ว ปุ่มคัดลอก/ไปเติมจึงไม่มีประโยชน์ ตัดทิ้งดีกว่าปล่อยให้กดแล้วได้จุด
                 ? '<div class="codeacts"><span class="masknote">ซ่อนโค้ดไว้ในไฟล์ที่แชร์</span></div>'
                 : `<div class="codeacts">
                 <button class="btn tiny act-copy">คัดลอก</button>
                 ${REDEEM_URL[r.gameId]
                   ? `<a class="btn tiny act-redeem" href="${esc(REDEEM_URL[r.gameId])}"
                        target="_blank" rel="noopener"
                        title="คัดลอกโค้ดให้ แล้วเปิดหน้าเติมโค้ดของ ${esc(r.gameName)}">ไปเติม ↗</a>`
                   : ''}
               </div>`}`
            : '<span class="nocode">ยังไม่ได้ใส่โค้ด</span>'}</td>
        <td class="range">${fmtDate(r.start)}<br><span class="to">→ ${fmtDate(r.end)}</span></td>
        <td>${esc(r.limit || '—')}</td>
        <td class="items">${items || '—'}${extra}
            ${(r.conditions || []).length ? `<br><span class="cond">${esc(r.conditions.join(' / '))}</span>` : ''}</td>
        <td><span class="pill ${r.status}">${STATUS_TH[r.status]}</span></td>
        <td>
          <div class="result">
            <span class="mark ${res ? res.status : 'none'}">${
              res ? (RESULT_TH[res.status] || res.status) : '– ยังไม่ตรวจ'}</span>
            <button class="btn tiny act-pass">ผ่าน</button>
            <button class="btn tiny act-fail">ไม่ผ่าน</button>
            ${manual[r.key] ? '<button class="btn tiny act-reset">ล้าง</button>' : ''}
          </div>
          ${res ? `<span class="result-note">${res.source === 'redeem-runner' ? 'runner · ' : ''}${esc(res.at)}${res.note ? ' · ' + esc(res.note) : ''}</span>` : ''}
        </td>
      </tr>`;
    }).join('');

    el.info.textContent = `แสดง ${page.length} จาก ${list.length} รายการ (ทั้งหมด ${rows.length})`;
    el.more.classList.toggle('hidden', page.length >= list.length);
  }

  function markResult(key, status) {
    if (!status) { delete manual[key]; }
    else {
      const note = status === 'fail'
        ? (prompt('เติมไม่ได้เพราะอะไร? (เว้นว่างได้)') || '')
        : '';
      const d = new Date();
      manual[key] = {
        status,
        note,
        at: `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
        source: 'manual'
      };
    }
    saveResults();
    refresh();
  }

  const refresh = () => { render(); buildSummary(); buildCheckCalendar(); };

  /**
   * บันทึกผลทีเดียวทั้งชุดที่กรองอยู่ — เขียนเฉพาะ manual (localStorage)
   * ผลจาก redeem runner ไม่ถูกแตะ เพราะนั่นเป็นผลตรวจจริงจากหน้าเว็บ
   */
  function markBulk(status) {
    const list = filtered().filter(r => r.code);
    if (!list.length) { alert('ไม่มีโค้ดในชุดที่กรองอยู่'); return; }

    const what = status === null ? 'ล้างผลที่กรอกเอง'
      : status === 'pass' ? 'บันทึกว่า "เติมได้"' : 'บันทึกว่า "เติมไม่ได้"';
    if (!confirm(`${what} ให้ ${list.length} โค้ดที่แสดงอยู่ตอนนี้?`)) return;

    const note = status === 'fail' ? (prompt('เติมไม่ได้เพราะอะไร? (เว้นว่างได้)') || '') : '';
    const d = new Date();
    const at = `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    list.forEach(r => {
      if (status === null) delete manual[r.key];
      else manual[r.key] = { status, note, at, source: 'manual' };
    });
    saveResults();
    refresh();
  }

  document.getElementById('btnBulkPass').addEventListener('click', () => markBulk('pass'));
  document.getElementById('btnBulkFail').addEventListener('click', () => markBulk('fail'));
  document.getElementById('btnBulkClear').addEventListener('click', () => markBulk(null));

  el.tbody.addEventListener('click', ev => {
    const btn = ev.target.closest('button, a.act-redeem');
    if (!btn) return;

    // กดวันที่ในบรรทัด "คล้ายกับ" = กระโดดไปดูโค้ดของวันนั้น
    if (btn.classList.contains('daylink')) {
      el.game.value = btn.dataset.game;
      el.from.value = btn.dataset.date;
      el.to.value = btn.dataset.date;
      el.status.value = ''; el.result.value = ''; el.risk.value = ''; el.search.value = '';
      shown = PAGE_SIZE;
      render();
      return;
    }

    const key = btn.closest('tr').dataset.key;

    // "ไปเติม" คัดลอกโค้ดให้ก่อน แล้วปล่อยให้ลิงก์เปิดแท็บใหม่ตามปกติ (ไม่ preventDefault)
    if (btn.classList.contains('act-redeem')) {
      const code = btn.closest('td').querySelector('.codeval').textContent;
      navigator.clipboard.writeText(code).catch(() => {});
      const copyBtn = btn.closest('td').querySelector('.act-copy');
      if (copyBtn) {
        copyBtn.textContent = 'คัดลอกแล้ว';
        setTimeout(() => { copyBtn.textContent = 'คัดลอก'; }, 2000);
      }
      return;
    }

    if (btn.classList.contains('act-copy')) {
      const code = btn.closest('td').querySelector('.codeval').textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'คัดลอกแล้ว';
        setTimeout(() => { btn.textContent = 'คัดลอก'; }, 1200);
      });
    }
    if (btn.classList.contains('act-pass')) markResult(key, 'pass');
    if (btn.classList.contains('act-fail')) markResult(key, 'fail');
    if (btn.classList.contains('act-reset')) markResult(key, null);
  });

  // --------------------------------------------------------------- filters

  ['change', 'input'].forEach(evt => {
    [el.game, el.status, el.result, el.risk, el.from, el.to, el.search]
      .forEach(node => node.addEventListener(evt, () => { shown = PAGE_SIZE; render(); }));
  });

  document.getElementById('btnMore').addEventListener('click', () => { shown += PAGE_SIZE; render(); });

  document.getElementById('btnToday').addEventListener('click', () => {
    el.from.value = todayIso; el.to.value = todayIso; shown = PAGE_SIZE; render();
  });

  document.getElementById('btnClear').addEventListener('click', () => {
    [el.game, el.status, el.result, el.risk, el.from, el.to, el.search].forEach(n => { n.value = ''; });
    shown = PAGE_SIZE; render();
  });

  document.getElementById('btnHowRefresh').addEventListener('click',
    () => document.getElementById('dlgRefresh').showModal());

  // ------------------------------------------------------- export / import

  // ปุ่มพวกนี้ถูกตัดออกในไฟล์สแนปช็อตที่แจกเป็นลิงก์ (ดาวน์โหลด/เลือกไฟล์ใช้ไม่ได้)
  const onClick = (id, fn) => {
    const node = document.getElementById(id);
    if (node) node.addEventListener('click', fn);
  };

  onClick('btnExport', () => {
    const head = ['เกม', 'วันที่', 'ชีท', 'โค้ด', 'เริ่ม', 'สิ้นสุด', 'Limit', 'สถานะ',
                  'ผลตรวจสอบ', 'หมายเหตุ', 'ความเสี่ยงถูกเดา', 'เหตุผลที่เสี่ยง', 'ไอเทม'];
    const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.map(cell).join(',')];
    filtered().forEach(r => {
      const res = resultOf(r.key);
      lines.push([
        r.gameName, r.date || '', r.sheet, r.code || '', r.start || '', r.end || '', r.limit || '',
        STATUS_TH[r.status],
        res ? (RESULT_TH[res.status] || res.status).replace(/^\S+\s/, '') : 'ยังไม่ตรวจ',
        res ? res.note : '',
        RISK_TH[riskOf(r).level] || '',
        riskOf(r).reasons.join(' · '),
        (r.items || []).map(i => `${i.name}${i.amount ? ' x' + i.amount : ''}`).join(' | ')
      ].map(cell).join(','));
    });
    // BOM เพื่อให้ Excel อ่านภาษาไทยถูก
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `itemcode-check-${todayIso}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  onClick('btnImport', () => document.getElementById('fileImport').click());

  const fileInput = document.getElementById('fileImport');
  if (fileInput) fileInput.addEventListener('change', ev => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let imported = 0, unmatched = 0;
      try {
        const payload = JSON.parse(reader.result);
        (payload.results || payload).forEach(item => {
          if (!item || !item.code) return;
          const matched = rows.filter(r => r.gameId === item.gameId && r.code === item.code);
          if (!matched.length) { unmatched++; return; }
          matched.forEach(match => {
            manual[match.key] = {
              status: RESULT_TH[item.status] ? item.status : 'unknown',
              note: item.message || '',
              at: (item.checkedAt || '').replace('T', ' ').slice(0, 16),
              source: 'redeem-runner'
            };
          });
          imported++;
        });
        saveResults(); refresh();
        alert(`นำเข้าผลแล้ว ${imported} รายการ` + (unmatched ? `\nจับคู่ไม่ได้ ${unmatched} รายการ` : ''));
      } catch (e) {
        alert('อ่านไฟล์ไม่ได้: ' + e.message);
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  });

  // ------------------------------------------- เช็คเองว่ามีข้อมูลใหม่จากชีทหรือยัง

  /**
   * poll ไฟล์เล็ก data/version.json (ไม่ใช่ codes.json ทั้งก้อน) ทุก 30 วินาที
   * ถ้า generatedAt ไม่ตรงกับที่โหลดมา = สคริปต์ดึงชีทรอบใหม่ไปแล้ว
   * ใช้ได้เมื่อเปิดผ่าน http (Serve.ps1) — เปิดแบบ file:// จะ fetch ไม่ได้ ก็เงียบไป
   */
  function watchForUpdates() {
    const bar = document.getElementById('updateBar');
    const chk = document.getElementById('chkAuto');
    const AUTO_KEY = 'itemcode-autorefresh';

    // ไฟล์สแนปช็อตที่แจกเป็นลิงก์ ไม่มีเซิร์ฟเวอร์ให้ถาม จึงไม่ต้องมีสวิตช์นี้
    if (window.__SNAPSHOT__) {
      const label = chk.closest('label');
      if (label) label.remove();
      return;
    }

    chk.checked = localStorage.getItem(AUTO_KEY) !== 'off';
    chk.addEventListener('change', () => {
      localStorage.setItem(AUTO_KEY, chk.checked ? 'on' : 'off');
      if (!chk.checked) bar.classList.add('hidden');
    });
    document.getElementById('btnReload').addEventListener('click', () => location.reload());

    if (location.protocol === 'file:') { chk.disabled = true; return; }

    let failures = 0;
    setInterval(async () => {
      if (!chk.checked) return;
      try {
        const res = await fetch('data/version.json?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        const v = await res.json();
        failures = 0;
        if (v.generatedAt && v.generatedAt !== DATA.generatedAt) {
          bar.classList.remove('hidden');
          // ไม่มีอะไรค้างให้เสียหาย โหลดใหม่ได้เลย แต่ทิ้งจังหวะให้ทันอ่านแถบแจ้งเตือน
          setTimeout(() => { if (chk.checked) location.reload(); }, 4000);
        }
      } catch (e) {
        if (++failures >= 5) chk.checked = false;   // เสิร์ฟเวอร์ดับ ก็เลิก poll
      }
    }, 30000);
  }

  // ------------------------------------------------------------------ init

  document.getElementById('generatedAt').textContent =
    'ข้อมูลอัปเดตเมื่อ ' + (DATA.generatedAt || '').replace('T', ' ').slice(0, 16);

  buildCalendar();
  watchForUpdates();
  refresh();
})();
