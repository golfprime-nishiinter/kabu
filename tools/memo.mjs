#!/usr/bin/env node
// Daily market memo for the board ("今日の相場メモ").
//
//   node tools/memo.mjs collect --out <dir>     gather the day's figures, find similar past days, print a brief
//   node tools/memo.mjs build --dir <dir>       combine the figures with the written text into daily.json
//
// collect reads the day's S&P 500, VIX and Fear & Greed figures from the board page itself, adds the
// public daily history from the St. Louis Fed (FRED) and the S&P 500 sample file bundled with the
// open-source "arch" Python package (1999-2018), and looks for past days whose market state was closest
// to today's. Every number in the memo comes from this script; the writer only adds the words.
// Nothing here is published as raw index history: only the memo itself goes to the daily-data branch.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const BOARD_URL = 'https://golfprime-nishiinter.github.io/kabu/';
const DAILY_URL = 'https://raw.githubusercontent.com/golfprime-nishiinter/kabu/daily-data/daily.json';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const ARCH_VERSION = '9.0.0';
const ARCH_MEMBER = 'arch/data/sp500/sp500.csv.gz';

const LOOKBACK = 252;        // trading days needed before a day can be described
const RECENT_GAP = 63;       // the latest quarter is the current episode, not a past one
const EPISODE_GAP = 42;      // picked days must be at least two months apart
const PICKS = 12;            // past episodes used for the statistics
const SHOWN = 5;             // past episodes listed on the board
const HORIZONS = { w1: 5, m1: 20, m3: 60 };
const PATH_DAYS = 60;

// How much each trait counts when two days are compared.
const WEIGHTS = { dd: 1.0, ma200: 0.8, r5: 0.8, r20: 1.0, r60: 0.7, lv: 1.2, vr: 0.8, rv: 0.6, r1: 0.3 };

// Well-known stretches, used only to label a past day.
const EPISODES = [
  ['2000-03-10', '2001-09-10', 'ITバブル崩壊'],
  ['2001-09-11', '2001-10-31', '同時多発テロ後'],
  ['2001-11-01', '2002-10-09', 'ITバブル崩壊（後半）'],
  ['2002-10-10', '2003-03-31', 'ITバブル後の底入れ期'],
  ['2006-05-10', '2006-06-30', '2006年の世界同時株安'],
  ['2007-02-27', '2007-03-16', '上海ショック'],
  ['2007-07-20', '2007-09-30', 'サブプライム問題の表面化'],
  ['2007-10-10', '2008-09-12', '世界金融危機（前半）'],
  ['2008-09-15', '2009-03-09', 'リーマン・ショック'],
  ['2009-03-10', '2009-07-31', '金融危機後の底入れ期'],
  ['2010-04-26', '2010-07-06', '欧州債務危機'],
  ['2011-07-25', '2011-10-31', '米国債格下げ・欧州債務危機'],
  ['2012-04-03', '2012-06-15', '欧州債務不安の再燃'],
  ['2013-05-22', '2013-06-28', 'バーナンキ・ショック'],
  ['2014-09-19', '2014-10-31', '2014年10月の急落'],
  ['2015-08-18', '2015-10-15', 'チャイナ・ショック'],
  ['2015-12-30', '2016-02-29', '原油安・中国不安'],
  ['2016-06-24', '2016-07-08', '英国のEU離脱決定'],
  ['2018-01-29', '2018-02-09', 'VIXショック'],
  ['2018-02-12', '2018-05-04', 'VIXショック後のもみ合い'],
  ['2018-10-03', '2018-12-24', '2018年末の急落'],
  ['2018-12-26', '2019-02-28', '2018年末急落からの回復期'],
  ['2019-05-01', '2019-06-07', '米中貿易摩擦'],
  ['2019-07-29', '2019-08-30', '米中貿易摩擦・逆イールド'],
  ['2020-02-20', '2020-03-23', 'コロナ・ショック'],
  ['2020-03-24', '2020-06-30', 'コロナ・ショック後の急回復'],
  ['2020-09-03', '2020-10-30', '2020年秋のハイテク株調整'],
  ['2021-11-26', '2021-12-20', 'オミクロン株への警戒'],
  ['2022-01-04', '2022-10-12', '2022年の利上げ弱気相場'],
  ['2022-10-13', '2023-01-31', '弱気相場からの底入れ期'],
  ['2023-03-09', '2023-03-31', '米地銀の経営破綻（SVB）'],
  ['2023-08-01', '2023-10-27', '長期金利の上昇局面'],
  ['2024-04-01', '2024-04-19', '2024年4月の調整'],
  ['2024-07-17', '2024-08-15', '円キャリー巻き戻しの急落'],
  ['2025-02-20', '2025-04-08', 'トランプ関税ショック'],
  ['2025-04-09', '2025-06-30', '関税ショック後の急回復']
];

const RATING_JA = { 'extreme fear': '極度の恐怖', fear: '恐怖', neutral: '中立', greed: '強欲', 'extreme greed': '極度の強欲' };
const COMPONENTS = [
  ['market_momentum_sp500', '株価の勢い'],
  ['stock_price_strength', '高値・安値銘柄数'],
  ['stock_price_breadth', '売買高の広がり'],
  ['put_call_options', 'プット/コール比率'],
  ['market_volatility_vix', 'VIX'],
  ['safe_haven_demand', '安全資産への逃避'],
  ['junk_bond_demand', '低格付け債の需要']
];
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

// ---------- small helpers ----------
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function round(x, digits) { const k = 10 ** digits; return Math.round(x * k) / k; }
function pct(x, digits = 1) { return round(x * 100, digits); }
function signed(x, digits = 1, unit = '%') {
  const sign = x > 0 ? '+' : x < 0 ? '−' : '±';
  return sign + Math.abs(x).toFixed(digits) + unit;
}
function comma(x, digits = 2) {
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function median(list) {
  const a = list.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function jpDate(iso, withYear = true) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return (withYear ? y + '年' : '') + m + '月' + d + '日（' + wd + '）';
}
function isoOfMs(ms) { return new Date(ms).toISOString().slice(0, 10); }
function episodeOf(iso) {
  const hit = EPISODES.find((e) => iso >= e[0] && iso <= e[1]);
  return hit ? hit[2] : '';
}
// Inverse of the standard normal distribution (Acklam's approximation).
function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- inputs ----------
function curl(url, file) {
  // Plain client, one request at a time (the site asks robots for a one-second crawl delay).
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execFileSync('curl', ['-fsS', '-m', '120', '-o', file, url], { stdio: ['ignore', 'ignore', 'pipe'] });
      return true;
    } catch (e) { lastError = e; }
  }
  console.error('download failed: ' + url + ' (' + String(lastError && lastError.message).split('\n')[0] + ')');
  return false;
}
function readFredCsv(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [d, v] = line.trim().split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) continue;
    const x = Number(v);
    if (v && isFinite(x) && x > 0) out.set(d, x);
  }
  return out;
}
function readArchCsv(file) {
  // Columns: Date (M/D/YYYY), Open, High, Low, Close, Adj Close, Volume
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const head = lines[0].split(',').map((s) => s.trim());
  const col = head.indexOf('Close');
  if (head[0] !== 'Date' || col < 0) return out;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((cells[0] || '').trim());
    const x = Number(cells[col]);
    if (!m || !isFinite(x) || !(x > 0)) continue;
    out.set(m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0'), x);
  }
  return out;
}
function fetchArchSample(dir) {
  // The S&P 500 sample file (1999-2018) that ships inside the "arch" package on PyPI.
  const csv = path.join(dir, 'arch_sp500.csv');
  if (fs.existsSync(csv)) return csv;
  try {
    const dl = path.join(dir, 'pypi');
    fs.mkdirSync(dl, { recursive: true });
    execFileSync('python3', ['-m', 'pip', 'download', 'arch==' + ARCH_VERSION, '--no-deps', '-q', '-d', dl], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180000 });
    const wheel = fs.readdirSync(dl).find((f) => f.startsWith('arch-' + ARCH_VERSION) && f.endsWith('.whl'));
    if (!wheel) throw new Error('package file not found');
    const gz = execFileSync('python3', ['-I', '-c',
      'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',
      path.join(dl, wheel), ARCH_MEMBER], { maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(csv, zlib.gunzipSync(gz));
    return csv;
  } catch (e) {
    console.error('older S&P 500 history unavailable: ' + String(e.message).split('\n')[0]);
    return null;
  }
}
async function readBoard(target, file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { chromium } = require('playwright');
  const url = /^https?:/.test(target) ? target : pathToFileURL(path.resolve(target)).href;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.MB_DATA && window.MB_DATA.cnn, null, { timeout: 60000 });
    const data = await page.evaluate(() => window.MB_DATA);
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  } finally {
    await browser.close();
  }
}
function dailyPoints(series) {
  // CNN series: one point per trading day at 00:00 UTC, plus a last point stamped with the update time.
  const out = new Map();
  for (const p of (series && Array.isArray(series.data) ? series.data : [])) {
    if (p && isFinite(p.x) && isFinite(p.y)) out.set(isoOfMs(p.x), p.y);
  }
  return out;
}

// ---------- the calendar of trading days with close and VIX ----------
function buildCalendar(archSpx, fredSpx, cnnSpx, fredVix, cnnVix) {
  const spx = new Map(archSpx);
  for (const [d, v] of fredSpx) spx.set(d, v);
  for (const [d, v] of cnnSpx) if (!spx.has(d)) spx.set(d, v);
  const vix = new Map(fredVix);
  for (const [d, v] of cnnVix) vix.set(d, v);          // CNN carries the latest day, FRED lags by one
  const vixDays = Array.from(vix.keys()).sort();
  const days = Array.from(spx.keys()).sort();
  let k = -1;
  return days.map((d) => {
    while (k + 1 < vixDays.length && vixDays[k + 1] <= d) k++;
    let v = null;
    if (k >= 0) {
      const gap = (Date.parse(d) - Date.parse(vixDays[k])) / 86400000;
      if (gap <= 4) v = vix.get(vixDays[k]);
    }
    return { d, c: spx.get(d), v };
  });
}

function describeDays(cal) {
  const n = cal.length;
  const f = new Array(n).fill(null);
  for (let i = LOOKBACK - 1; i < n; i++) {
    const c = cal[i].c;
    if (cal[i].v === null) continue;
    let hi = -Infinity, hiAt = i;
    for (let k = i - LOOKBACK + 1; k <= i; k++) if (cal[k].c >= hi) { hi = cal[k].c; hiAt = k; }
    let s200 = 0;
    for (let k = i - 199; k <= i; k++) s200 += cal[k].c;
    let s50 = 0, n50 = 0;
    for (let k = i - 49; k <= i; k++) if (cal[k].v !== null) { s50 += cal[k].v; n50++; }
    if (n50 < 40) continue;
    let m = 0, q = 0;
    for (let k = i - 19; k <= i; k++) { const r = Math.log(cal[k].c / cal[k - 1].c); m += r; q += r * r; }
    f[i] = {
      dd: c / hi - 1,
      hiAt,
      ma200: c / (s200 / 200) - 1,
      r1: c / cal[i - 1].c - 1,
      r5: c / cal[i - 5].c - 1,
      r20: c / cal[i - 20].c - 1,
      r60: c / cal[i - 60].c - 1,
      lv: Math.log(cal[i].v),
      vr: cal[i].v / (s50 / n50) - 1,
      rv: Math.sqrt(Math.max(0, q / 20 - (m / 20) ** 2) * 252)
    };
  }
  return f;
}

// Each trait becomes its position within the whole history, so one extreme trait cannot swamp the rest.
function standardize(f) {
  const idx = [];
  f.forEach((x, i) => { if (x) idx.push(i); });
  const z = new Array(f.length).fill(null);
  idx.forEach((i) => { z[i] = {}; });
  for (const key of Object.keys(WEIGHTS)) {
    const order = idx.slice().sort((p, q) => f[p][key] - f[q][key]);
    let s = 0;
    while (s < order.length) {
      let e = s;
      while (e + 1 < order.length && f[order[e + 1]][key] === f[order[s]][key]) e++;
      const score = normInv(((s + e) / 2 + 0.5) / order.length);
      for (let k = s; k <= e; k++) z[order[k]][key] = score;
      s = e + 1;
    }
  }
  return z;
}

function forward(cal, i) {
  const n = cal.length, c0 = cal[i].c;
  const out = {};
  for (const [name, h] of Object.entries(HORIZONS)) out[name] = i + h < n ? cal[i + h].c / c0 - 1 : null;
  const pathPts = [];
  let low = 0, lowAt = 0, lev = 1;
  const levAt = {};
  for (let k = 0; k <= PATH_DAYS && i + k < n; k++) {
    const r = cal[i + k].c / c0 - 1;
    pathPts.push(round(r * 100, 1));
    if (r < low) { low = r; lowAt = k; }
    if (k > 0) {
      lev *= Math.max(0, 1 + 3 * (cal[i + k].c / cal[i + k - 1].c - 1));
      if (k === HORIZONS.m1) levAt.m1 = lev - 1;
      if (k === HORIZONS.m3) levAt.m3 = lev - 1;
    }
  }
  out.path = pathPts;
  out.low = low;
  out.lowAt = lowAt;
  out.lev = levAt;
  return out;
}

function summarize(values) {
  const a = values.filter((v) => v !== null && v !== undefined);
  if (!a.length) return null;
  return { n: a.length, up: a.filter((v) => v > 0).length, med: pct(median(a)), min: pct(Math.min(...a)), max: pct(Math.max(...a)) };
}

function analyze(cal) {
  const f = describeDays(cal);
  const z = standardize(f);
  const T = cal.length - 1;
  if (!f[T]) throw new Error('not enough history to describe the latest day');
  const keys = Object.keys(WEIGHTS);
  const scored = [];
  for (let i = 0; i <= T - RECENT_GAP; i++) {
    if (!z[i]) continue;
    let d2 = 0;
    for (const k of keys) d2 += WEIGHTS[k] * (z[i][k] - z[T][k]) ** 2;
    scored.push({ i, dist: Math.sqrt(d2) });
  }
  scored.sort((p, q) => p.dist - q.dist);
  const picks = [];
  for (const s of scored) {
    if (picks.length >= PICKS) break;
    if (picks.some((p) => Math.abs(p.i - s.i) < EPISODE_GAP)) continue;
    picks.push(s);
  }
  const analogs = picks.map((p) => {
    const fw = forward(cal, p.i);
    return {
      d: cal[p.i].d,
      label: episodeOf(cal[p.i].d),
      dist: round(p.dist, 2),
      then: { close: cal[p.i].c, vix: cal[p.i].v, dd: pct(f[p.i].dd), ma200: pct(f[p.i].ma200), r5: pct(f[p.i].r5), r20: pct(f[p.i].r20), r60: pct(f[p.i].r60) },
      w1: fw.w1 === null ? null : pct(fw.w1),
      m1: fw.m1 === null ? null : pct(fw.m1),
      m3: fw.m3 === null ? null : pct(fw.m3),
      low: pct(fw.low),
      lowAt: fw.lowAt,
      lev1: fw.lev.m1 === undefined ? null : pct(fw.lev.m1),
      lev3: fw.lev.m3 === undefined ? null : pct(fw.lev.m3),
      path: fw.path
    };
  });

  // What an ordinary day looked like afterwards, for comparison.
  const base = {};
  for (const [name, h] of Object.entries(HORIZONS)) {
    const all = [];
    for (let i = 0; i + h <= T; i++) if (f[i]) all.push(cal[i + h].c / cal[i].c - 1);
    base[name] = { upPct: Math.round(all.filter((v) => v > 0).length / all.length * 100), med: pct(median(all)) };
  }
  // First year the search can reach (a year that only starts in its last weeks counts as the next one).
  const first = cal[f.findIndex((x) => x)].d;
  const stats = {
    n: analogs.length,
    since: Number(first.slice(0, 4)) + (first.slice(5, 7) > '06' ? 1 : 0),
    w1: summarize(analogs.map((a) => (a.w1 === null ? null : a.w1 / 100))),
    m1: summarize(analogs.map((a) => (a.m1 === null ? null : a.m1 / 100))),
    m3: summarize(analogs.map((a) => (a.m3 === null ? null : a.m3 / 100))),
    low: summarize(analogs.map((a) => a.low / 100)),
    lev1: summarize(analogs.map((a) => (a.lev1 === null ? null : a.lev1 / 100))),
    lev3: summarize(analogs.map((a) => (a.lev3 === null ? null : a.lev3 / 100))),
    base
  };
  return { f, T, analogs, stats };
}

// ---------- collect ----------
async function collect() {
  const out = path.resolve(arg('out', '.'));
  fs.mkdirSync(out, { recursive: true });
  const board = arg('board', BOARD_URL);

  // Stop early when the market is open (the day's figures are not final) or nothing is new.
  const now = new Date();
  const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const part = (t) => ny.find((p) => p.type === t).value;
  const nyMinutes = (Number(part('hour')) % 24) * 60 + Number(part('minute'));
  const weekday = !['Sat', 'Sun'].includes(part('weekday'));
  if (weekday && nyMinutes >= 9 * 60 + 25 && nyMinutes < 16 * 60 + 20 && !process.argv.includes('--force')) {
    console.log('SKIP: 米国市場の取引時間中のため、今日の数値はまだ確定していません。');
    return;
  }

  const snap = await readBoard(board, path.join(out, 'snapshot.json'));
  const cnn = snap.cnn;
  const cnnSpx = dailyPoints(cnn.market_momentum_sp500);
  const cnnVix = dailyPoints(cnn.market_volatility_vix);
  const latest = Array.from(cnnSpx.keys()).sort().pop();
  if (!latest) throw new Error('the board returned no S&P 500 figures');

  if (!process.argv.includes('--force')) {
    const prev = path.join(out, 'published.json');
    if (curl(DAILY_URL, prev)) {
      try {
        const p = JSON.parse(fs.readFileSync(prev, 'utf8'));
        if (p && p.date === latest) {
          console.log('SKIP: ' + latest + ' の相場メモは公開済みです（米国市場の新しい取引日がありません）。');
          return;
        }
      } catch (e) { /* unreadable previous memo: carry on and replace it */ }
    }
  }

  const spxFile = path.join(out, 'fred_SP500.csv');
  const vixFile = path.join(out, 'fred_VIXCLS.csv');
  if (!fs.existsSync(spxFile)) { curl(FRED_CSV + 'SP500', spxFile); await sleep(1500); }
  if (!fs.existsSync(vixFile)) { curl(FRED_CSV + 'VIXCLS', vixFile); await sleep(1500); }
  const fredSpx = readFredCsv(spxFile);
  const fredVix = readFredCsv(vixFile);
  if (fredSpx.size < 2000 || fredVix.size < 5000) throw new Error('the public history files could not be read (S&P 500 ' + fredSpx.size + ' days, VIX ' + fredVix.size + ' days)');
  const archFile = fetchArchSample(out);
  const archSpx = archFile ? readArchCsv(archFile) : new Map();

  // The two S&P 500 sources must agree where they overlap, and so must FRED and the board.
  const checks = [];
  for (const [name, a] of [['arch', archSpx], ['board', cnnSpx]]) {
    let n = 0, worst = 0;
    for (const [d, v] of a) if (fredSpx.has(d)) { n++; worst = Math.max(worst, Math.abs(v / fredSpx.get(d) - 1)); }
    checks.push({ source: name, overlapDays: n, largestGapPct: round(worst * 100, 3) });
    if (n > 20 && worst > 0.002) throw new Error('S&P 500 figures from ' + name + ' and FRED disagree by ' + round(worst * 100, 2) + '%');
  }

  const cal = buildCalendar(archSpx, fredSpx, cnnSpx, fredVix, cnnVix);
  const T = cal.length - 1;
  if (cal[T].d !== latest) throw new Error('calendar ends on ' + cal[T].d + ', expected ' + latest);
  for (let i = cal.length - 300; i < cal.length; i++) {
    if (i > 0 && (Date.parse(cal[i].d) - Date.parse(cal[i - 1].d)) / 86400000 > 5) throw new Error('missing trading days before ' + cal[i].d);
  }
  const { f, analogs, stats } = analyze(cal);
  const t = f[T];

  // Today's figures.
  const fg = cnn.fear_and_greed || {};
  const fgHist = dailyPoints(cnn.fear_and_greed_historical);
  const fgVals = Array.from(fgHist.values());
  const vixAll = Array.from(fredVix.values());
  const vixRank = Math.round(vixAll.filter((v) => v < cal[T].v).length / vixAll.length * 100);
  const yearStart = cal.findLast((x) => x.d < latest.slice(0, 4) + '-01-01');
  const comps = COMPONENTS.map(([key, name]) => ({ name, rating: RATING_JA[String((cnn[key] || {}).rating || '').toLowerCase()] || '' })).filter((c) => c.rating);
  const recent = [];
  for (let i = T - 9; i <= T; i++) recent.push({ d: cal[i].d, close: cal[i].c, chg: pct(cal[i].c / cal[i - 1].c - 1, 2), vix: cal[i].v });
  let bigMoveSince = null;
  for (let i = T - 1; i > 0; i--) {
    if (Math.abs(cal[i].c / cal[i - 1].c - 1) >= Math.abs(t.r1)) { bigMoveSince = cal[i].d; break; }
  }
  // Calendar week and month so far, and the last week that moved as far in the same direction.
  const mondayOf = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
  };
  const weeks = [];
  for (const x of cal) {
    const key = mondayOf(x.d);
    if (weeks.length && weeks[weeks.length - 1].key === key) { weeks[weeks.length - 1].d = x.d; weeks[weeks.length - 1].c = x.c; }
    else weeks.push({ key, d: x.d, c: x.c });
  }
  const W = weeks.length - 1;
  const weekChg = weeks[W].c / weeks[W - 1].c - 1;
  let weekSince = null;
  for (let i = W - 1; i > 0; i--) {
    const r = weeks[i].c / weeks[i - 1].c - 1;
    if ((weekChg >= 0 && r >= weekChg) || (weekChg < 0 && r <= weekChg)) { weekSince = weeks[i].d; break; }
  }
  const weekEnded = new Date(latest + 'T00:00:00Z').getUTCDay() === 5;
  const monthStart = cal.findLast((x) => x.d < latest.slice(0, 7) + '-01');
  const today = {
    date: latest,
    spx: { close: cal[T].c, chg: pct(t.r1, 2), r5: pct(t.r5), r20: pct(t.r20), r60: pct(t.r60), dd: pct(t.dd), highDate: cal[t.hiAt].d, high: cal[t.hiAt].c, ma200: pct(t.ma200), ytd: yearStart ? pct(cal[T].c / yearStart.c - 1) : null, mtd: monthStart ? pct(cal[T].c / monthStart.c - 1) : null, week: pct(weekChg), weekEnded, weekAsBigLastSeen: weekSince, swing20: pct(t.rv), sameOrBiggerMoveLastSeen: bigMoveSince },
    vix: { value: cal[T].v, prev: cal[T - 1].v, chg: round(cal[T].v - cal[T - 1].v, 2), higherThanPctOfDaysSince1990: vixRank, vs50dayAvg: pct(t.vr) },
    fng: {
      score: isFinite(fg.score) ? Math.round(fg.score) : null,
      rating: RATING_JA[String(fg.rating || '').toLowerCase()] || '',
      prevClose: isFinite(fg.previous_close) ? Math.round(fg.previous_close) : null,
      weekAgo: isFinite(fg.previous_1_week) ? Math.round(fg.previous_1_week) : null,
      monthAgo: isFinite(fg.previous_1_month) ? Math.round(fg.previous_1_month) : null,
      yearAgo: isFinite(fg.previous_1_year) ? Math.round(fg.previous_1_year) : null,
      lowerThanPctOfPastYear: fgVals.length && isFinite(fg.score) ? Math.round(fgVals.filter((v) => v > fg.score).length / fgVals.length * 100) : null,
      components: comps
    },
    recent
  };

  const facts = { v: 1, generated: now.toISOString(), today, analogs, stats, checks, historyFrom: cal[0].d, days: cal.length };
  fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(facts, null, 1));
  fs.writeFileSync(path.join(out, 'memo.template.json'), JSON.stringify(template(facts), null, 2));
  console.log(brief(facts, out));
}

function template(facts) {
  return {
    date: facts.today.date,
    headline: '',
    summary: '',
    drivers: [{ t: '', s: '', u: '' }],
    notes: Object.fromEntries(facts.analogs.slice(0, SHOWN).map((a) => [a.d, ''])),
    takeaway: ''
  };
}

function analogLine(a) {
  const f = (v) => (v === null ? '—' : signed(v));
  return '  ' + a.d + (a.label ? '【' + a.label + '】' : '') +
    ' 当時: 高値から' + signed(a.then.dd) + '・200日線' + signed(a.then.ma200) + '・20日' + signed(a.then.r20) + '・VIX ' + a.then.vix.toFixed(1) +
    ' → 1週間後 ' + f(a.w1) + ' / 1か月後 ' + f(a.m1) + ' / 3か月後 ' + f(a.m3) +
    '（60営業日以内の最安 ' + signed(a.low) + '、' + a.lowAt + '営業日目）';
}

function brief(facts, out) {
  const t = facts.today, s = facts.stats;
  const L = [];
  L.push('=== 相場メモ用の数値（' + jpDate(t.date) + ' の米国市場・終値）===');
  L.push('S&P500: ' + comma(t.spx.close) + '（前日比 ' + signed(t.spx.chg, 2) + '）／5日 ' + signed(t.spx.r5) + '・20日 ' + signed(t.spx.r20) + '・60日 ' + signed(t.spx.r60) + (t.spx.ytd === null ? '' : '・年初来 ' + signed(t.spx.ytd)));
  L.push('  52週高値（終値 ' + comma(t.spx.high) + '、' + t.spx.highDate + '）から ' + signed(t.spx.dd) + '／200日移動平均から ' + signed(t.spx.ma200) + '／直近20日の値動きの荒さ（年率）' + t.spx.swing20.toFixed(0) + '%');
  if (t.spx.sameOrBiggerMoveLastSeen) L.push('  今日と同じかそれ以上の1日の値動きが前回あった日: ' + t.spx.sameOrBiggerMoveLastSeen);
  L.push('  ' + (t.spx.weekEnded ? '今週（週間）' : '今週ここまで') + ': ' + signed(t.spx.week) + (t.spx.weekEnded && t.spx.weekAsBigLastSeen ? '（同じ向きでこれ以上動いた週は ' + t.spx.weekAsBigLastSeen + ' の週が最後）' : '') + (t.spx.mtd === null ? '' : '／今月ここまで: ' + signed(t.spx.mtd)));
  L.push('VIX: ' + t.vix.value.toFixed(2) + '（前日 ' + t.vix.prev.toFixed(2) + '、' + signed(t.vix.chg, 2, '') + '）／1990年以降の営業日の ' + t.vix.higherThanPctOfDaysSince1990 + '% より高い水準／50日平均比 ' + signed(t.vix.vs50dayAvg));
  L.push('Fear & Greed: ' + t.fng.score + '（' + t.fng.rating + '）／前日 ' + t.fng.prevClose + '・1週間前 ' + t.fng.weekAgo + '・1か月前 ' + t.fng.monthAgo + '・1年前 ' + t.fng.yearAgo + (t.fng.lowerThanPctOfPastYear === null ? '' : '／過去1年の ' + t.fng.lowerThanPctOfPastYear + '% の日より低い'));
  L.push('  内訳: ' + t.fng.components.map((c) => c.name + '=' + c.rating).join('、'));
  L.push('直近10営業日（S&P500 終値・前日比・VIX）:');
  for (const r of t.recent) L.push('  ' + r.d + '  ' + comma(r.close) + '  ' + signed(r.chg, 2) + '  VIX ' + (r.vix === null ? '—' : r.vix.toFixed(2)));
  L.push('');
  L.push('=== 過去の似た局面（' + s.since + '年以降のS&P500とVIXから機械的に抽出。近い順、上位' + SHOWN + '件がボードに載る）===');
  facts.analogs.forEach((a, i) => { L.push((i === SHOWN ? '  ---- 以下は集計にだけ使う ----\n' : '') + analogLine(a)); });
  L.push('');
  L.push('=== 集計（似た局面 ' + s.n + ' 回）===');
  const row = (name, x, b) => name + ': 上昇 ' + x.up + '/' + x.n + ' 回・中央値 ' + signed(x.med) + '・最悪 ' + signed(x.min) + '・最良 ' + signed(x.max) + (b ? '（全期間の普通の日: 上昇 ' + b.upPct + '%・中央値 ' + signed(b.med) + '）' : '');
  if (s.w1) L.push(row('1週間後', s.w1, s.base.w1));
  if (s.m1) L.push(row('1か月後', s.m1, s.base.m1));
  if (s.m3) L.push(row('3か月後', s.m3, s.base.m3));
  if (s.low) L.push('その後60営業日以内の最大下落: 中央値 ' + signed(s.low.med) + '・最悪 ' + signed(s.low.min));
  if (s.lev1 && s.lev3) L.push('3倍レバレッジ型の概算（毎日3倍・経費は無視）: 1か月後 中央値 ' + signed(s.lev1.med) + '・最悪 ' + signed(s.lev1.min) + '／3か月後 中央値 ' + signed(s.lev3.med) + '・最悪 ' + signed(s.lev3.min));
  L.push('');
  L.push('=== 書き方 ===');
  L.push('1. 今日の米国株が動いた理由をウェブ検索で2〜3回調べる（例:「米国株 ' + t.date + '」「Wall Street stocks ' + t.date + '」）。検索語に個人名や非公開の情報は入れない。');
  L.push('2. ' + path.join(out, 'memo.template.json') + ' と同じ形で ' + path.join(out, 'memo.json') + ' を書く。すべて日本語・です/ます調・投資の初心者にも分かる言葉で。');
  L.push('   headline: 今日の相場を一言で（30字以内）。');
  L.push('   summary: 今日何が起きたか、いまの市場の状態（2〜3文、160字以内）。');
  L.push('   drivers: 動いた理由を2〜4件。t=内容（60字以内）、s=情報源の名前、u=その記事のURL（https、検索で実際に確認したものだけ）。確認できなければ空の配列にする。');
  L.push('   notes: 上位' + SHOWN + '件の日付ごとに、当時何が起きていた局面で、その後どうなったかを1〜2文（90字以内）。当時の出来事に確信がない日付は空文字にする。');
  L.push('   takeaway: 集計から言えること・言えないことを2〜3文（200字以内）。似た局面でも結果はばらつくこと、SPXL・SOXL・TQQQ のような3倍型は下落時の傷が大きくなることに触れる。売買の推奨や断定的な予想は書かない。');
  L.push('3. 数字は上の一覧にあるもの、または検索で確認して出典を付けたものだけを使う。記憶に頼った数字は書かない。');
  L.push('4. node ' + path.resolve(process.argv[1]) + ' build --dir ' + out + ' を実行し、エラーが出たら memo.json を直してやり直す。');
  return L.join('\n');
}

// ---------- build ----------
function build() {
  const dir = path.resolve(arg('dir', '.'));
  const facts = JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8'));
  const memo = JSON.parse(fs.readFileSync(path.join(dir, 'memo.json'), 'utf8'));
  const errors = [];
  const text = (v, name, max, required) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) errors.push(name + ' が空です');
    if (s.length > max) errors.push(name + ' が長すぎます（' + s.length + '字、上限 ' + max + '字）');
    if (/[<>]/.test(s)) errors.push(name + ' に < や > は使えません');
    return s;
  };
  if (memo.date !== facts.today.date) errors.push('date が数値の日付（' + facts.today.date + '）と違います');
  const headline = text(memo.headline, 'headline', 30, true);
  const summary = text(memo.summary, 'summary', 160, true);
  const takeaway = text(memo.takeaway, 'takeaway', 200, true);
  const drivers = [];
  (Array.isArray(memo.drivers) ? memo.drivers : []).forEach((d, i) => {
    if (!d || (!d.t && !d.u)) return;
    const t = text(d.t, 'drivers[' + i + '].t', 60, true);
    const s = text(d.s, 'drivers[' + i + '].s', 30, false);
    const u = typeof d.u === 'string' ? d.u.trim() : '';
    if (u && !/^https:\/\/[^\s"'<>]+$/.test(u)) errors.push('drivers[' + i + '].u は https で始まるURLにしてください');
    drivers.push(u ? { t, s, u } : { t, s });
  });
  if (drivers.length > 4) errors.push('drivers は4件までです');
  const shown = facts.analogs.slice(0, SHOWN);
  const notes = memo.notes && typeof memo.notes === 'object' ? memo.notes : {};
  for (const k of Object.keys(notes)) if (!shown.some((a) => a.d === k)) errors.push('notes の日付 ' + k + ' は上位' + SHOWN + '件にありません');
  if (errors.length) {
    console.error('memo.json を直してください:\n- ' + errors.join('\n- '));
    process.exit(1);
  }

  const t = facts.today, s = facts.stats;
  const dir3 = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const daily = {
    v: 1,
    date: t.date,
    updated: new Date().toISOString(),
    headline,
    summary,
    today: [
      { k: 'S&P500', v: comma(t.spx.close), d: signed(t.spx.chg, 2), s: dir3(t.spx.chg) },
      { k: 'VIX', v: t.vix.value.toFixed(2), d: signed(t.vix.chg, 2, ''), s: dir3(t.vix.chg) },
      { k: 'Fear & Greed', v: String(t.fng.score), d: t.fng.rating, s: 0 }
    ],
    state: [
      '52週高値から ' + signed(t.spx.dd),
      '200日線から ' + signed(t.spx.ma200),
      '直近20日 ' + signed(t.spx.r20),
      'VIXは1990年以降の' + t.vix.higherThanPctOfDaysSince1990 + '%の日より高い'
    ],
    drivers,
    analogs: shown.map((a) => ({
      d: a.d,
      label: a.label,
      then: '高値から' + signed(a.then.dd) + '・VIX ' + a.then.vix.toFixed(1),
      w1: a.w1, m1: a.m1, m3: a.m3, low: a.low,
      path: a.path,
      note: text(notes[a.d], 'notes.' + a.d, 90, false)
    })),
    stats: { n: s.n, since: s.since, w1: s.w1, m1: s.m1, m3: s.m3, low: s.low, lev1: s.lev1, lev3: s.lev3, base: s.base },
    takeaway
  };
  if (errors.length) {
    console.error('memo.json を直してください:\n- ' + errors.join('\n- '));
    process.exit(1);
  }
  const file = path.join(dir, 'daily.json');
  fs.writeFileSync(file, JSON.stringify(daily));
  console.log('OK: ' + file + '（' + fs.statSync(file).size + ' バイト）を書き出しました。');
}

const command = process.argv[2];
if (command === 'collect') {
  collect().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
} else if (command === 'build') {
  build();
} else {
  console.error('usage: node memo.mjs collect --out <dir> | build --dir <dir>');
  process.exit(2);
}
