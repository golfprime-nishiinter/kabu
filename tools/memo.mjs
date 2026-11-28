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

// How much each trait counts when two days are compared. "fg" is the Fear & Greed reading:
// the real one for today, an estimate built from FG_INPUTS for past days (see estimateSentiment).
const WEIGHTS = { fg: 1.5, dd: 1.0, ma200: 0.6, r5: 0.8, r20: 1.0, r60: 0.7, lv: 1.2, vr: 0.8, rv: 0.6, r1: 0.3 };
const FG_INPUTS = ['mom125', 'vr', 'r20'];   // the mix that held up best on months it was not fitted on

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
    let s125 = 0;
    for (let k = i - 124; k <= i; k++) s125 += cal[k].c;
    let s50 = 0, n50 = 0;
    for (let k = i - 49; k <= i; k++) if (cal[k].v !== null) { s50 += cal[k].v; n50++; }
    if (n50 < 40) continue;
    let m = 0, q = 0;
    for (let k = i - 19; k <= i; k++) { const r = Math.log(cal[k].c / cal[k - 1].c); m += r; q += r * r; }
    f[i] = {
      dd: c / hi - 1,
      hiAt,
      ma200: c / (s200 / 200) - 1,
      mom125: c / (s125 / 125) - 1,
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
function standardize(f, keys) {
  const idx = [];
  f.forEach((x, i) => { if (x) idx.push(i); });
  const z = new Array(f.length).fill(null);
  idx.forEach((i) => { z[i] = {}; });
  for (const key of keys) {
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

// Least squares with an intercept (normal equations, elimination with pivoting).
function fitLinear(X, y) {
  const k = X[0].length + 1;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  X.forEach((x, r) => {
    const row = [1, ...x];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += row[i] * row[j];
      A[i][k] += row[i] * y[r];
    }
  });
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const m = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= m * A[c][j];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
}

// The board carries about a year of real Fear & Greed readings. Over that year the index is fitted to
// traits that exist for every day (price against its 125-day average, VIX against its 50-day average,
// the 20-day move: the same kind of ingredients the index itself is built from); the fit then gives an
// estimate for each past day, so "how fearful was the market" can be compared across the whole history.
// It is rough (typically 6 points off), so the board shows it rounded and labelled as an estimate.
// Today always uses the real reading. Returns null (and the search goes without it) when the fit is poor.
function estimateSentiment(cal, f, fgHist, fgToday) {
  const rows = [];
  cal.forEach((x, i) => { if (f[i] && fgHist.has(x.d)) rows.push(i); });
  if (rows.length < 150 || !isFinite(fgToday)) return null;
  const xOf = (i) => FG_INPUTS.map((k) => f[i][k]);
  const yOf = (list) => list.map((i) => fgHist.get(cal[i].d));
  const predict = (beta, i) => Math.max(0, Math.min(100, beta[0] + xOf(i).reduce((sum, v, k) => sum + beta[k + 1] * v, 0)));
  const score = (beta, list) => {
    const y = yOf(list);
    const mean = y.reduce((sum, v) => sum + v, 0) / y.length;
    let sse = 0, sst = 0, sae = 0;
    list.forEach((i, n) => { const e = y[n] - predict(beta, i); sse += e * e; sae += Math.abs(e); sst += (y[n] - mean) ** 2; });
    return { r2: round(1 - sse / sst, 2), mae: round(sae / list.length, 1) };
  };
  const beta = fitLinear(rows.map(xOf), yOf(rows));
  if (!beta) return null;
  // A harder check: fit on the older 60% of the year, score on the newer 40%.
  const cut = Math.floor(rows.length * 0.6);
  const early = fitLinear(rows.slice(0, cut).map(xOf), yOf(rows.slice(0, cut)));
  const fit = score(beta, rows);
  if (fit.r2 < 0.6) return null;
  f.forEach((x, i) => { if (x) x.fg = predict(beta, i); });
  f[cal.length - 1].fg = fgToday;
  return { days: rows.length, r2: fit.r2, mae: fit.mae, heldOut: early ? score(early, rows.slice(cut)) : null };
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

function analyze(cal, fgHist, fgToday) {
  const f = describeDays(cal);
  const T = cal.length - 1;
  if (!f[T]) throw new Error('not enough history to describe the latest day');
  const sentiment = estimateSentiment(cal, f, fgHist, fgToday);
  const keys = Object.keys(WEIGHTS).filter((k) => k !== 'fg' || sentiment);
  const z = standardize(f, keys);
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
      then: { close: cal[p.i].c, vix: cal[p.i].v, fg: sentiment ? Math.round(f[p.i].fg) : null, dd: pct(f[p.i].dd), ma200: pct(f[p.i].ma200), r5: pct(f[p.i].r5), r20: pct(f[p.i].r20), r60: pct(f[p.i].r60) },
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
  return { f, T, analogs, stats, sentiment };
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

  let cal = buildCalendar(archSpx, fredSpx, cnnSpx, fredVix, cnnVix);
  // Use only the unbroken stretch that ends today: a hole between two sources must not be read as a price move.
  for (let i = cal.length - 1; i > 0; i--) {
    if ((Date.parse(cal[i].d) - Date.parse(cal[i - 1].d)) / 86400000 > 10) {
      console.error('history has a gap before ' + cal[i].d + '; using the days from there on');
      cal = cal.slice(i);
      break;
    }
  }
  const T = cal.length - 1;
  if (cal[T].d !== latest) throw new Error('calendar ends on ' + cal[T].d + ', expected ' + latest);
  if (cal.length < LOOKBACK + RECENT_GAP + 250) throw new Error('only ' + cal.length + ' trading days of unbroken history');
  const fg = cnn.fear_and_greed || {};
  const fgHist = dailyPoints(cnn.fear_and_greed_historical);
  const { f, analogs, stats, sentiment } = analyze(cal, fgHist, Number(fg.score));
  const t = f[T];

  // Earlier stretches, within the board's year of real readings, when Fear & Greed was as low
  // (or as high) as it is today, and what the S&P 500 did from the day it first got there.
  const fngPast = [];
  const side = !isFinite(fg.score) ? 0 : fg.score < 45 ? -1 : fg.score > 55 ? 1 : 0;
  if (side) {
    const limit = fg.score;
    const at = (i) => fgHist.get(cal[i].d);
    const hit = (i) => fgHist.has(cal[i].d) && (side < 0 ? at(i) <= limit : at(i) >= limit);
    const firstKnown = cal.findIndex((x) => fgHist.has(x.d));
    const ret = (i, h) => (i + h <= T ? pct(cal[i + h].c / cal[i].c - 1) : null);
    let i = firstKnown;
    while (i >= 0 && i <= T) {
      if (!hit(i)) { i++; continue; }
      let end = i, ext = i;
      for (let k = i + 1, miss = 0; k <= T && miss <= 10; k++) {
        if (!hit(k)) { miss++; continue; }
        miss = 0;
        end = k;
        if (side < 0 ? at(k) < at(ext) : at(k) > at(ext)) ext = k;
      }
      // A stretch that reaches into the last 20 trading days is the current one, not a past one.
      if (end <= T - 20) {
        fngPast.push({ from: cal[i].d, to: cal[end].d, startedEarlier: i === firstKnown, first: Math.round(at(i)), extreme: Math.round(at(ext)), extremeDate: cal[ext].d, w1: ret(i, HORIZONS.w1), m1: ret(i, HORIZONS.m1), m3: ret(i, HORIZONS.m3) });
      }
      i = end + 11;
    }
  }
  const tally = (key) => {
    const v = fngPast.map((e) => e[key]).filter((x) => x !== null);
    return { n: v.length, up: v.filter((x) => x > 0).length };
  };
  const fngPastTally = { w1: tally('w1'), m1: tally('m1'), m3: tally('m3') };

  // Today's figures.
  const fgVals = Array.from(fgHist.values());
  const vixAll = Array.from(fredVix.values());
  const vixRank = Math.round(vixAll.filter((v) => v < cal[T].v).length / vixAll.length * 100);
  const yearStart = cal.findLast((x) => x.d < latest.slice(0, 4) + '-01-01');
  const comps = COMPONENTS.map(([key, name]) => ({ name, rating: RATING_JA[String((cnn[key] || {}).rating || '').toLowerCase()] || '' })).filter((c) => c.rating);
  const count = (words) => comps.filter((c) => words.includes(c.rating)).length;
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
      components: comps,
      fearCount: count(['極度の恐怖', '恐怖']),
      neutralCount: count(['中立']),
      greedCount: count(['強欲', '極度の強欲']),
      side,
      past: fngPast,
      pastTally: fngPastTally,
      estimate: sentiment
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
    news: [{ h: '', t: '', s: '', u: '' }],
    fngNote: '',
    notes: Object.fromEntries(facts.analogs.slice(0, SHOWN).map((a) => [a.d, ''])),
    takeaway: ''
  };
}

function analogLine(a) {
  const f = (v) => (v === null ? '—' : signed(v));
  return '  ' + a.d + (a.label ? '【' + a.label + '】' : '') +
    ' 当時: 高値から' + signed(a.then.dd) + '・200日線' + signed(a.then.ma200) + '・20日' + signed(a.then.r20) + '・VIX ' + a.then.vix.toFixed(1) + (a.then.fg === null ? '' : '・F&G相当（推定）' + a.then.fg) +
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
  L.push('  内訳（7項目）: 恐怖側 ' + t.fng.fearCount + '・中立 ' + t.fng.neutralCount + '・強欲側 ' + t.fng.greedCount + '｜' + t.fng.components.map((c) => c.name + '=' + c.rating).join('、'));
  if (t.fng.side) {
    const word = t.fng.side < 0 ? '以下まで下がった' : '以上まで上がった';
    if (t.fng.past.length) {
      L.push('  この1年の実績: Fear & Greed が今日の水準' + word + '過去の局面と、その水準に最初に達した日からのS&P500');
      const g = (v) => (v === null ? '—' : signed(v));
      const y = t.fng.pastTally;
      L.push('    まとめ: ' + t.fng.past.length + ' 回。上がっていた回数は 1週間後 ' + y.w1.up + '/' + y.w1.n + '・1か月後 ' + y.m1.up + '/' + y.m1.n + '・3か月後 ' + y.m3.up + '/' + y.m3.n + '（まだ日数がたっていない回は数えていない）');
      for (const e of t.fng.past) L.push('    ' + e.from + '〜' + e.to + (e.startedEarlier ? '（データの始まりより前から続いていた）' : '') + ' 初日の値 ' + e.first + '・' + (t.fng.side < 0 ? '最低 ' : '最高 ') + e.extreme + '（' + e.extremeDate + '）→ 1週間後 ' + g(e.w1) + ' / 1か月後 ' + g(e.m1) + ' / 3か月後 ' + g(e.m3));
    } else {
      L.push('  この1年の実績: Fear & Greed が今日の水準' + word + '局面は、今回のほかにはありません。');
    }
  }
  if (t.fng.estimate) L.push('  過去の日の Fear & Greed は実測が1年分しかないため、同じ材料（株価と125日平均の差、VIXと50日平均の差など）からの推定値を使う。この1年の実測との当てはまり: 決定係数 ' + t.fng.estimate.r2 + '・平均誤差 ' + t.fng.estimate.mae + ' ポイント' + (t.fng.estimate.heldOut ? '（前半で作って後半で試すと 決定係数 ' + t.fng.estimate.heldOut.r2 + '・平均誤差 ' + t.fng.estimate.heldOut.mae + '）' : ''));
  L.push('直近10営業日（S&P500 終値・前日比・VIX）:');
  for (const r of t.recent) L.push('  ' + r.d + '  ' + comma(r.close) + '  ' + signed(r.chg, 2) + '  VIX ' + (r.vix === null ? '—' : r.vix.toFixed(2)));
  L.push('');
  L.push('=== 過去の似た局面（' + s.since + '年以降。S&P500・VIX' + (t.fng.estimate ? '・Fear & Greed（過去分は推定）' : '') + 'の状態が今日に近い日を機械的に抽出。近い順、上位' + SHOWN + '件がボードに載る）===');
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
  L.push('1. ウェブ検索を4〜5回まで使い、今日の米国株が動いた理由と、その日の気になるニュースを調べる（例:「米国株 ' + t.date + '」「Wall Street stocks ' + t.date + '」「半導体 AI 株 ニュース」「FRB 金利 見通し」「来週 米国 経済指標 予定」）。検索語に個人名や非公開の情報は入れない。');
  L.push('2. ' + path.join(out, 'memo.template.json') + ' と同じ形で ' + path.join(out, 'memo.json') + ' を書く。すべて日本語・です/ます調・投資の初心者にも分かる言葉で。');
  L.push('   headline: 今日の相場を一言で（30字以内）。');
  L.push('   summary: 今日何が起きたか、いまの市場の状態（2〜3文、160字以内）。Fear & Greed の水準にも触れる。');
  L.push('   news: その日の気になるニュースを3〜5件。h=見出し（40字以内）、t=要約（2〜3文、140字以内。何が起きて、なぜ株価に関係するのか）、s=情報源の名前、u=その記事のURL（https、検索結果に実際に出てきたものだけ）。');
  L.push('         選ぶ目安: 相場全体を動かした材料／金利・FRB・物価／AI・半導体・大型ハイテク（SOXL・TQQQ に関係）／ドル円／これから数日の重要な予定（経済指標・FRB会合・決算）。同じ話題を重ねない。検索で確認できた内容だけを書く。');
  L.push('   fngNote: Fear & Greed について1〜2文（120字以内）。今の水準と前日・1週間前からの変化、内訳、上の「この1年の実績」があればその「まとめ」の回数をそのまま使って触れる（回数が少ないことも書く）。');
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
  const news = [];
  (Array.isArray(memo.news) ? memo.news : []).forEach((d, i) => {
    if (!d || (!d.h && !d.t)) return;
    const h = text(d.h, 'news[' + i + '].h', 40, true);
    const t = text(d.t, 'news[' + i + '].t', 140, true);
    const s = text(d.s, 'news[' + i + '].s', 30, true);
    const u = typeof d.u === 'string' ? d.u.trim() : '';
    if (!/^https:\/\/[^\s"'<>]+$/.test(u)) errors.push('news[' + i + '].u は検索結果に出てきた記事の https のURLにしてください');
    news.push({ h, t, s, u });
  });
  if (news.length < 3) errors.push('news は3件以上必要です（いまは ' + news.length + ' 件）。検索結果の見出しと要約から書いてください');
  if (news.length > 5) errors.push('news は5件までです');
  const fngNote = text(memo.fngNote, 'fngNote', 120, true);
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
    news,
    fng: {
      score: t.fng.score,
      rating: t.fng.rating,
      prev: t.fng.prevClose,
      week: t.fng.weekAgo,
      month: t.fng.monthAgo,
      fear: t.fng.fearCount,
      neutral: t.fng.neutralCount,
      greed: t.fng.greedCount,
      items: t.fng.components,
      side: t.fng.side,
      past: t.fng.past.slice(-4),
      pastCount: t.fng.past.length,
      pastTally: t.fng.pastTally,
      estimated: !!t.fng.estimate,
      note: fngNote
    },
    analogs: shown.map((a) => ({
      d: a.d,
      label: a.label,
      // The estimate is rough, so it is shown to the nearest five.
      then: '高値から' + signed(a.then.dd) + '・VIX ' + a.then.vix.toFixed(1) + (a.then.fg === null || a.then.fg === undefined ? '' : '・F&G 約' + Math.round(a.then.fg / 5) * 5 + '（推定）'),
      w1: a.w1, m1: a.m1, m3: a.m3, low: a.low,
      path: a.path,
      note: text(notes[a.d], 'notes.' + a.d, 90, false)
    })),
    stats: { n: s.n, since: s.since, w1: s.w1, m1: s.m1, m3: s.m3, low: s.low, lev1: s.lev1, lev3: s.lev3, base: s.base, days: facts.analogs.map((a) => a.d) },
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
