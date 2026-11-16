# データ形式と実装構成

## 実装構成

```
src/
  shared/        収集・保存・出力の中核（chrome API に依存しない部分は単体テスト対象）
    types.ts           データ形式（schemaVersion 1）
    inputAggregator.ts 入力の集約（IME 対応）の状態機械
    sensitive.ts       機密欄の判定
    elementInfo.ts     要素情報・入力値の読み取り
    selectors.ts       セレクター候補と一致件数、動的ID・位置依存の判定
    domSerialize.ts    操作時点の DOM とフォーム状態の直列化
    export.ts          ZIP 出力（置換・除外・参照検査・Markdown テンプレート）
    db.ts              IndexedDB
    messages.ts        拡張内メッセージの型
  content/       コンテンツスクリプト（対象タブにのみ注入。操作の観測）
  background/    Service Worker（セッション制御、画面取得、権限失効の扱い）
  sidepanel/     記録パネル（React）
  review/        レビュー画面・出力ダイアログ（React）
  ui/            共通UI・テーマ・画像の塗りつぶし処理
mock-site/       模擬業務ページ（本体から独立）
tests/unit/      単体テスト（Vitest）
tests/e2e/       実ブラウザ検証（Playwright）
```

処理の流れ: コンテンツスクリプトが操作を観測 → Service Worker が順序番号を振って IndexedDB に保存し、画面を取得 → パネルとレビュー画面は IndexedDB を直接読む。セッションの進行状態は `chrome.storage.session` に置くため、Service Worker が停止しても記録は継続します。

収集側は Selenium などの自動化技術に依存しません。出力は中立的な JSON / HTML / Markdown / PNG です。

## 階層

プロジェクト → シナリオ → 操作ステップ → 成果物（画面・DOM）。すべてのレコードが `schemaVersion` を持ちます。

| 対象 | 主な項目 |
|---|---|
| Project | `id` `name` `description` `createdAt` |
| Scenario | `name` `purpose` `preconditions` `expectedResult` `openQuestions` `sessions[]`（記録日時・状態・ブラウザ等の環境・一時停止履歴） `groups[]` `replacementRules[]` |
| Step | 下表 |
| Artifact | `type`(screenshot/dom) `capturedAt` `phase` `includeInExport`、画像は `blob` `meta` `masks[]`、DOM は `html` `formState[]` |

### Step

| 項目 | 内容 |
|---|---|
| `id` / `seq` | 一意なIDと、元の操作順（除外・グループ化しても不変） |
| `kind` | `session-start` `click` `input` `select` `check` `key` `navigation` `reload` `spa-navigation` `manual-capture` `element-note` `session-end` `notice` |
| `operationAt` / `operationEndAt` | 操作を観測した時刻／集約した入力の最終編集時刻 |
| `page` / `frame` | URL・タイトル・ビューポート／フレームの経路（index、同一オリジンならセレクター） |
| `target` | 要素情報（タグ、id、name、type、role と由来、名前の候補、label、テキスト、placeholder、状態、位置とサイズ、属性、セレクター候補、周辺 DOM、Shadow DOM 経路） |
| `value` | 入力・選択内容。機密欄は `redacted: true` で値なし。select はその時点の候補一覧も保存 |
| `observations[]` | 画面変化の観測（DOM 変化、DOM 変化の静止、URL 変更、通知領域の表示、観測の終了理由）。**完了判定ではない** |
| `screenshot` / `dom` / `elementCapture` | 取得状況（`captured` / `failed` / `skipped` / `pending` / `not-applicable`）。失敗・未取得は必ず `reason` を持つ |
| `limitations[]` | その手順に固有の制限 |
| `humanConfirmedAt` | 人間が完了を確認した時刻 |
| `annotation` | 目的、補足、値の種別（未指定／固定／変数）、変数名、入力元、変換ルール、条件（次へ進む／成功、根拠つき）、分岐・繰り返し、未確認事項 |
| `includeInExport` / `groupId` | 出力対象か／グループ |

### 時刻の区別

| 時刻 | 保存先 |
|---|---|
| 操作が起きた時刻 | `Step.operationAt` |
| DOM・URL などの変化を観測した時刻 | `Step.observations[]` |
| 画像を取得した時刻 | `Artifact.capturedAt`（操作後の画面。操作前の画面としては扱わない） |
| 人間が完了を確認した時刻 | `Step.humanConfirmedAt` |
| 次の操作が起きた時刻 | 出力時に導出（`steps.json` の `time.nextOperationAt`） |

操作間隔を応答時間とは呼びません。DOM 変化の静止（既定 400ms）は「画面変化の観測」として記録し、業務処理の完了とは判定しません。

## 出力 ZIP

```
tracelens-export/
  README.md                   調査概要、環境、ファイル構成、制限、取得できなかった情報
  scenario.md                 操作順、意図、分岐、繰り返し、成功条件
  input-mapping.md            変数、入力元、登録先、変換ルール
  implementation-request.md   実装担当AIに渡す依頼文のひな型
  manifest.json               schemaVersion、出力日時、成果物一覧、除外した手順番号
  steps.json                  構造化された操作記録
  screenshots/step-NNNN-<stepId>.png
  dom/step-NNNN-<stepId>.html
  dom/step-NNNN-<stepId>.form-state.json
  elements/step-NNNN-<stepId>.json
```

- すべてのファイルは共通のステップID（`stp_…`）で対応します。`NNNN` は元の `seq` です。
- 除外した手順・成果物はファイルを出力せず、`steps.json` 側の `path` は `null`、`status` は `excluded-from-export` になります。出力時に参照切れを検査し、壊れた参照があれば出力を中止します。
- 値の置換はデータモデルに一度だけ適用し、Markdown・JSON・DOM はすべて置換済みデータから生成します。ID・時刻・種別などの構造項目は置換しません。
- 画像は必ず再エンコードした結果だけを出力します（塗りつぶしは画素に焼き込み）。保存済みの原本は ZIP に入りません。
- DOM の `data-tracelens-ref="n"` 属性は、`form-state.json` の `ref` に対応します（HTML 文字列に残らない現在値・選択状態）。
- Markdown はテンプレート生成です。未記入は「（未記入）」、未確認は「未確認」とそのまま出力し、推測で補いません。
