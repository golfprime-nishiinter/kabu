// Collects Japanese-language headlines about the US stock market and writes them as one small JSON file
// for the board to read. Runs on a schedule in GitHub Actions (see .github/workflows/news.yml).
//
// Source: Google News RSS search results (Japanese edition). Each query is one feed; results are merged,
// de-duplicated by headline and sorted newest first.
//
// Usage: node tools/build-news.mjs <output file>

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const QUERIES = [
  '米国株',
  'ニューヨーク株式市場 OR NYダウ OR ナスダック OR "S&P500"',
  '半導体株 OR エヌビディア OR SOX指数',
  'FRB OR FOMC OR 米雇用統計 OR 米消費者物価',
];
const MAX_AGE_HOURS = 48;
const MAX_ITEMS = 40;

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

function parseFeed(xml) {
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

// Two headlines count as the same story when they match after dropping spaces and punctuation.
const keyOf = (title) => title.replace(/[\s　、。，．・「」『』（）()【】［］\[\]!！?？:：\-―ー～〜…=＝|｜\/／"'“”‘’]/g, '').toLowerCase();

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

  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
  const seen = new Set();
  const items = all
    .filter((x) => new Date(x.d).getTime() >= cutoff && /[぀-ヿ一-鿿]/.test(x.t))
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
    .filter((x) => {
      const k = keyOf(x.t);
      if (k.length < 6 || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_ITEMS);

  // Keep the previous file in place rather than publish an empty or thin list.
  if (items.length < 5) throw new Error(`only ${items.length} headlines (${failed} of ${QUERIES.length} feeds failed)`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ updated: new Date().toISOString(), items }) + '\n');
  console.log(`wrote ${items.length} headlines to ${out}`);
  for (const x of items.slice(0, 8)) console.log(` ${x.d.slice(5, 16)} [${x.s}] ${x.t}`);
}

main().catch((e) => {
  console.error('news build failed: ' + e.message);
  process.exit(1);
});
