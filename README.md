# マーケットボード

SPXL・SOXL・TQQQ・VIX・ドル円・RSI・Fear & Greed と「今日の相場メモ」を 1 画面で見るためのページです。

- 価格・チャート: TradingView の埋め込みウィジェット
- Fear & Greed と VIX 現物: CNN Business のデータ（5 分ごとに読み込み）
- 今日の相場メモ: 米国市場の取引日ごとに 1 回、その日の状況と「過去の似た局面とその後」をまとめたもの。
  `daily-data` ブランチの `daily.json` を読み込んで表示します。

## 今日の相場メモの作り方

`tools/memo.mjs` が数値をすべて計算し、文章だけを AI（Claude）が書きます。

1. `node tools/memo.mjs collect --out <作業フォルダ>`
   ボードのページからその日の S&P500・VIX・Fear & Greed を読み取り、公開されている過去データ
   （セントルイス連銀 FRED、および Python パッケージ arch に同梱の S&P500 サンプルデータ）と合わせて、
   2000 年以降で市場の状態（S&P500・VIX・Fear & Greed）が今日に近かった日を探し、その後の値動きを集計します。
   Fear & Greed の実際の値は 1 年分しか取れないため、過去の日は同じ材料からの推定値を使います。
2. 出力された案内に沿って `memo.json`（見出し・要約・気になるニュースの要約・Fear & Greed の一言・
   各局面の説明・数字の見方）を書きます。
3. `node tools/memo.mjs build --dir <作業フォルダ>` で `daily.json` を作り、`daily-data` ブランチに置きます。

指数の過去データそのものはこのリポジトリには置いていません（毎回、公開元から取得します）。

`index.html` だけで動きます。表示は参考値で、投資の助言ではありません。
