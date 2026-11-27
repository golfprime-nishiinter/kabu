// Collects Japanese-language headlines about the US stock market and writes them as one small JSON file
// for the board to read. Runs on a schedule in GitHub Actions (see .github/workflows/news.yml).
//
// Source: Google News RSS search results (Japanese edition). Each query is one feed; results are merged,
// cleaned of non-news pages and off-topic items, de-duplicated and sorted newest first.
//
// Usage: node tools/build-news.mjs <output file>

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const QUERIES = [
  '米国株',
  'ニューヨーク株式市場 OR NYダウ OR ナスダック OR "S&P500"',
  '半導体株 OR エヌビディア OR SOX指数',
  'FRB OR FOMC OR 米雇用統計 OR 米消費者物価',
];
const MAX_AGE_HOURS = 48;
const MAX_ITEMS = 40;
const MAX_PER_SOURCE = 8;

// Quote and fund pages that the search returns alongside articles.
const NOT_NEWS = /株価・株式情報|投資信託情報|基準価[格額]|掲示板|チャート：|配当情報/;
// The board is about US stocks: drop crypto-led items, and other markets unless the US is in the headline too.
const CRYPTO = /仮想通貨|暗号資産|ビットコイン|イーサリアム|BTC|XRP|リップル/i;
const OTHER_MARKETS = /欧州株|日本株|東京株|東証|日経平均|日経半導体|中国株|香港株|上海株|韓国株|インド株/;
const US_MARKET = /米国|米株|NY|ニューヨーク|ウォール街|ナスダック|ダウ|S&P|FRB|FOMC/i;
// Press releases and video listings, not articles.
const SKIP_SOURCES = /PR TIMES|TVer/;

const feedUrl = (q) =>
  'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:2d') + '&hl=ja&gl=JP&ceid=JP:ja';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decode(m[1]) : '';
}

export function parseFeed(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const source = tag(block, 'source');
    let title = tag(block, 'title');
    // Google News appends " - <publisher>" to every headline.
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    const link = tag(block, 'link');
    const date = new Date(tag(block, 'pubDate'));
    if (!title || !/^https:\/\//.test(link) || Number.isNaN(date.getTime())) continue;
    items.push({ t: title, s: source, u: link, d: date.toISOString() });
  }
  return items;
}

// Same story, different wording: compare headlines by the two-character sequences they share.
const squash = (title) =>
  title.normalize('NFKC').replace(/[\s、。，．・「」『』（）()【】\[\]!?:\-―ー~〜…=|\/"'“”‘’＝]/g, '').toLowerCase();
function pairs(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}
function alike(a, b) {
  let shared = 0;
  for (const p of a) if (b.has(p)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.6;
}

// Publisher names arrive with site slogans attached ("Investing.com - FX | 株式市場 | …").
const cleanSource = (s) => s.split(/\s[-|｜]\s/)[0].trim();
// Some headlines carry the site name again at the end ("… | スマートニュース").
const cleanTitle = (t) => t.replace(/\s[|｜]\s[^|｜]{1,20}$/, '').trim();

export function refine(all, now = Date.now()) {
  const cutoff = now - MAX_AGE_HOURS * 3600 * 1000;
  const kept = [];
  const perSource = new Map();
  const sorted = all
    .map((x) => ({ ...x, t: cleanTitle(x.t), s: cleanSource(x.s) }))
    .filter((x) => new Date(x.d).getTime() >= cutoff)
    .filter((x) => /[぀-ヿ一-鿿]/.test(x.t) && squash(x.t).length >= 8)
    .filter((x) => !NOT_NEWS.test(x.t) && !CRYPTO.test(x.t) && !SKIP_SOURCES.test(x.s))
    .filter((x) => !OTHER_MARKETS.test(x.t) || US_MARKET.test(x.t))
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  for (const x of sorted) {
    const sig = pairs(squash(x.t));
    if (kept.some((k) => alike(sig, k.sig))) continue;
    const n = perSource.get(x.s) ?? 0;
    if (n >= MAX_PER_SOURCE) continue;
    perSource.set(x.s, n + 1);
    kept.push({ item: x, sig });
    if (kept.length >= MAX_ITEMS) break;
  }
  return kept.map((k) => k.item);
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node tools/build-news.mjs <output file>');

  const all = [];
  let failed = 0;
  for (const q of QUERIES) {
    try {
      const res = await fetch(feedUrl(q), {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; market-board-news/1.0)', 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const items = parseFeed(await res.text());
      console.log(`${items.length} items for: ${q}`);
      all.push(...items);
    } catch (e) {
      failed += 1;
      console.log(`feed failed for: ${q} (${e.message})`);
    }
  }

  const items = refine(all);
  // Keep the previous file in place rather than publish an empty or thin list.
  if (items.length < 5) throw new Error(`only ${items.length} headlines (${failed} of ${QUERIES.length} feeds failed)`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ updated: new Date().toISOString(), items }) + '\n');
  console.log(`wrote ${items.length} headlines to ${out} (from ${all.length} collected)`);
  for (const x of items.slice(0, 10)) console.log(` ${x.d.slice(5, 16)} [${x.s}] ${x.t}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error('news build failed: ' + e.message);
    process.exit(1);
  });
}
