# ITM分析ツール

ティッカーを入力すると、過去の株価データから「権利行使価格に対してどれくらいの確率でITMになったか」を計算するWebツール。
米国株のみ対応。データ取得元は [Twelve Data](https://twelvedata.com/)（無料プラン）。

## 構成

```
site/
  index.html        画面
  css/style.css      デザイン
  js/calc.js         ITM判定の計算ロジック（純粋関数。DOM・fetch非依存）
  js/chart.js         SVGグラフ生成（純粋関数）
  js/app.js           画面とロジックをつなぐ処理
functions/
  api/history.js       Twelve Data中継API（Cloudflare Pages Function）
```

- `calc.js` / `chart.js` は純粋関数のみで構成しており、判定ロジックやグラフ表現を変更したいときはここだけ触ればよい設計。
- `functions/api/history.js` がデータ取得元を隠蔽している。将来Twelve Data以外に差し替える場合もフロント側（`app.js`以降）は無改修で済む。

## データ取得とキャッシュの考え方

- 銘柄の価格データ（過去800営業日分、約3年）はティッカーを分析したタイミングで**1回だけ**取得する。取引タイプ・比率・判定期間・集計期間・エントリー条件を変更しても再取得はせず、取得済みデータをブラウザ内で再計算するだけ（無駄なAPI呼び出しをしない設計）。
- ブラウザ内メモリにも銘柄ごとのデータをキャッシュしており、同一ブラウザ内で複数タブに同じ銘柄を開いても実際のリクエストは1回だけ。
- サーバー側（`functions/api/history.js`）はCloudflare KV（`PRICE_CACHE`）で同一銘柄のレスポンスを20時間キャッシュしている。KVは全世界のCloudflare拠点で共有されるため、複数人での利用時も地域に関係なく「同じ銘柄への実アクセスは概ね1日1回」に抑えられる（KV書き込み後の反映に数秒〜最大1分のタイムラグがあるため、ごく稀に同時アクセスが重複することはある）。KVが未設定の環境でもキャッシュなしで動作は継続する。
- Twelve Data無料プランの上限は800 credits/日・8 requests/分。上記のキャッシュにより、通常利用でこの上限に達することはまず無い想定。

## ローカルでの確認

```bash
npx wrangler pages dev site --kv PRICE_CACHE
```

`.dev.vars`（Gitには含めない）に以下を設定しておくこと:

```
TWELVEDATA_API_KEY=（Twelve Dataのダッシュボードで発行したAPIキー）
```

## 本番デプロイ（Cloudflare Pages）

1. Cloudflare Pagesでこのリポジトリを連携し、Build output directory を `site` に設定
2. Cloudflareダッシュボードで Workers KV の名前空間を作成し、`wrangler.toml` の `[[kv_namespaces]]` に `binding = "PRICE_CACHE"` としてそのIDを設定（**KVなどのbindingsはダッシュボードからではなく `wrangler.toml` で管理される**。コミット・pushすれば反映される）
3. Pagesプロジェクトの Settings → **Variables and secrets** に `TWELVEDATA_API_KEY` を **Secret** 種別で追加（ダッシュボードから直接設定できるのはSecretのみ）
4. デプロイ後、`/api/history?symbol=AAPL` が正常にJSONを返すことを確認

## 今後の拡張余地

- 判定期間・判定バッジのしきい値は `site/js/calc.js` の上部に定数として集約してあるので調整が容易
- 米国株以外への対応やデータ提供元の追加は `functions/api/history.js` の差し替え/分岐で対応可能
- 複数銘柄比較などの機能追加は `app.js` に手を入れる形になるが、`calc.js`/`chart.js` は変更不要な想定
