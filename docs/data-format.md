# データ形式と実装構成

## 実装構成

```
src/
  shared/        収集・保存・出力の中核（chrome API に依存しない部分は単体テスト対象）
    types.ts           データ形式（schemaVersion 2）と v1 レコードの正規化
    inputAggregator.ts 入力の集約（IME 対応）の状態機械
    sensitive.ts       機密欄の判定
    elementInfo.ts     要素情報・入力値の読み取り
    selectors.ts       セレクター候補と一致件数、動的ID・位置依存の判定
    domSerialize.ts    操作時点の DOM とフォーム状態の直列化
    export.ts          ZIP 出力（置換・除外・参照検査・Markdown テンプレート）
    db.ts              IndexedDB（DB_VERSION 2）
    messages.ts        拡張内メッセージの型（再生の契約を含む）
    steps.ts           表示・再生順（order）、人が追加する手順
    groups.ts          グループの入れ子（循環の検査、パス、削除・名前変更・移動）
    variables.ts       シナリオ変数と値テンプレート（{{変数名}}）
    replay.ts          再生計画・実行前の確認・再生結果の型
    importScenario.ts  取り込み（シナリオ間のコピー、出力 ZIP の読み込み）
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

プロジェクト → シナリオ → 操作ステップ → 成果物（画面・DOM）。シナリオには再生結果（ReplayRun）がつきます。すべてのレコードが `schemaVersion` を持ちます。

### schemaVersion 2 と互換性

- 現在の形式は schemaVersion 2（`SCHEMA_VERSION`）、IndexedDB は `DB_VERSION` 2 です。
- v2 で追加した項目はすべて省略可能です。v1 のレコードは書き換えずにそのまま読み、読み込み時に `normalizeScenario` / `normalizeStep` / `normalizeProject` で既定値を補います（`variables: []`、グループの `parentId: null`、置換ルールの `isRegex: false`、手順の `origin: 'recorded'`）。レコードの `schemaVersion` は書き込まれた時点の値のまま残します（`patch*` で更新したレコードは補った既定値ごと保存されます）。
- DB の v1 → v2 の移行では `replayRuns` ストア（索引 `scenarioId`）を追加するだけで、既存のレコードは変更しません。
- 読める schemaVersion は 1 と 2（`SUPPORTED_SCHEMA_VERSIONS`）。それ以外の出力 ZIP は理由つきで取り込みを拒否します。

| 対象 | 主な項目 |
|---|---|
| Project | `id` `name` `description` `createdAt` |
| Scenario | `name` `purpose` `preconditions` `expectedResult` `openQuestions` `sessions[]`（記録日時・状態・ブラウザ等の環境・一時停止履歴） `groups[]` `replacementRules[]` `variables[]`(v2) |
| StepGroup | `id` `name` `parentId`(v2, null は最上位) `order`(v2, 同じ親の中の表示順) |
| ReplacementRule | `find` `replaceWith` `enabled` `isRegex`(v2) `flags`(v2) |
| ScenarioVariable (v2) | `id` `name` `defaultValue` `description` `secret`。secret の変数は既定値を保存しない（保存 API が落とす） |
| ReplayRun (v2) | 下記「再生計画と再生結果」 |
| Step | 下表 |
| Artifact | `captureInfo`(省略可。手動取得の方法 `method`: `visible`/`element`/`full-page`、`frameCount`、`composedHeightCss`、`pageHeightCss`、`partial`/`partialReason`、`cropRect`/`elementRectCss`/`elementClipped`、`notes[]`) `type`(screenshot/dom) `capturedAt` `phase` `includeInExport`、画像は `blob` `meta` `masks[]`（各要素は `kind`: `fill`(既定)/`blur` を省略可）`crop`(省略可) `cropSourceSize`(省略可)、DOM は `html` `formState[]` |

### 画像の編集（塗りつぶし・ぼかし・切り抜き）と名前の計算

- `masks[]` と `crop` の座標は**原本画像のピクセル座標**。`kind` が無い既存のマスクは塗りつぶしとして読む。`crop` と `cropSourceSize`（切り抜きを設定した時点の原本サイズ）は省略可能で、無ければ切り抜きなし。
- 出力画像は切り抜き範囲の画素だけから作り直し（範囲外の画素は出力に入らない）、そのうえで塗りつぶし（黒）とぼかし（領域短辺の約 1/3、最低 12px のブロック平均＋ボックスぼかし。元の画素は復元できない）を焼き込む。保存済みの原本は変更しない。
- `steps.json` の `artifacts.screenshot` に `maskedRegionCount`（塗りつぶし）`blurredRegionCount` `cropped` `imageSize`（出力 PNG の大きさ。読めなければ null）`imageEditNote` を出す。切り抜き時は `viewport` の width/height と `targetRectAtCapture` を切り抜き後の画像に合わせて変換する（scrollX/scrollY は切り抜き前の値のまま）。対象位置が切り抜き範囲の外、または原本サイズが不明で対応を確認できない場合は `targetRectAtCapture: null` と理由（`targetRectNote`）にする。切り抜きで除いた領域の座標は出力しない。`manifest.json` の `redaction` に `maskedImageRegions` `blurredImageRegions` `croppedImages` を出す。
- **画像内の文字は自動では検出しない。** 人間が目視で確認する前提。
- `target.nameCandidates[]` の先頭に、`source: 'accname'`（`rule` に決まった規則）の計算結果が入ることがある。以降は従来の簡易推定の候補で、意味は変えていない。`target.computedName`（`value` `rule` `ruleLabel` `note`）と `target.computedRole`（`value` `source`: `explicit`/`implicit-html-aam`/`none` `note`）は省略可能。`target.role` は従来どおりの簡易推定。
- 計算は W3C accname-1.2 と HTML-AAM の主要部分の独自実装であり、**ブラウザの結果との一致は未検証**。扱えないもの: CSS 生成内容(::before/::after)、closed Shadow DOM、レイアウト依存の可視判定の一部（display:none / visibility:hidden / hidden 属性 / aria-hidden のみ判定）、SVG の title/desc、aria-describedby、ブラウザ固有の差。機密欄の値は名前に含めない。


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
| `beforeScreenshot` | (v2・省略可) 操作前の画面への参照（任意設定）。`status`: `captured`（`artifactId` `refStepId` `capturedAt` = 参照先の画像の取得時刻）/ `skipped`（`reasonCode` と `reason`）。`basis` は常に `previous-observation`。新しい画像ではなく、直前の観測で取得した画像を、観測の範囲（DOM・スクロール・リサイズ）で画面変化がなかったときだけ参照する。画面が同一である保証ではなく、操作直前に取得した画像でもない |
| `humanConfirmedAt` | 人間が完了を確認した時刻 |
| `annotation` | 目的、補足、値の種別（未指定／固定／変数）、変数名、入力元、変換ルール、条件（次へ進む／成功、根拠つき）、分岐・繰り返し、未確認事項 |
| `includeInExport` / `groupId` | 出力対象か／グループ |
| `origin` (v2) | `recorded`（記録。未指定はこれ）/ `imported`（取り込み）/ `authored`（人が追加） |
| `order` (v2) | 表示・再生順。未指定は `seq`。並べ替えはこの値だけを変える（`orderedSteps()` で並べる。`listSteps` は従来どおり seq 昇順） |
| `replay` (v2) | 再生・編集の設定（下表）。記録された事実（`target` `value` など）は変えずに別に持つ |
| `importedFrom` (v2) | 取り込み元（`source`: scenario / export-zip、元のシナリオ ID・名前、元の `stepId` `seq` `operationAt` `operationEndAt` `humanConfirmedAt`、取り込んだ時刻） |

`kind` には v2 で `wait`（人が追加した、待機条件だけの手順）が加わりました。

#### 追加・取り込みした手順の番号と時刻

- `authored` / `imported` の手順の `seq` は、そのシナリオの最大 `seq` + 1 から振ります。削除・並べ替え・取り込みで既存の手順の `seq` は変えません。
- これらの手順の `operationAt` は作成（取り込み）した時刻で、記録された操作時刻ではありません（`origin` で区別）。取り込み元の時刻は `importedFrom` に残し、取り込んだ手順の `operationEndAt` `humanConfirmedAt` は空にします。観測（`observations`）・画像・DOM の時刻は取り込み元の記録時のもので、その旨を `limitations` に残します。
- 取り込んだ手順の `sessionId` は取り込み単位の ID（`imp_…`）、人が追加した手順は `authored` で、どちらも `sessions[]` には現れません。
- 記録中のシナリオへの追加・取り込みは、記録側の採番と衝突するため行わない前提です。

#### 再生設定 `Step.replay` (v2)

| 項目 | 内容 |
|---|---|
| `skip` | 再生しない。`includeInExport`（出力対象か）とは独立 |
| `valueTemplate` | 入力・選択に使う値。`{{変数名}}` を含められる。未指定は記録値（記録値はテンプレートとして解釈しない）。select では解決後の値を option の value として使う |
| `selector` | 人が指定したセレクター（`language`: css / xpath）。記録された候補より先に試す。安定性は未検証 |
| `wait` | 操作後の待機条件（WaitCondition）。未指定は既定（DOM 変化の 400ms の静止。上限 2.5 秒） |
| `onFail` | `stop`（既定）/ `continue` |
| `timeoutMs` | 1 手順の上限時間（既定 10 秒） |

WaitCondition: `kind` = `none` / `element-present` / `element-absent`（`value` は CSS セレクター）/ `text-present`（`value` を含む文字列。`isRegex` で正規表現）/ `url-matches`（URL が `value` を含む。`isRegex` で正規表現）/ `dom-quiet`（`quietMs`）。記録時の操作間隔（時刻差）は待機時間に使いません。DOM 変化の静止は画面変化の観測であり、業務処理の完了ではありません。

#### 変数と値テンプレート

- 書式は `{{変数名}}`（前後の空白は無視）。変数名は 1〜64 文字の文字・数字と `_ - ・ .`。`{{` をそのまま書く方法はありません。
- 値が与えられない変数は未解決として扱い（`resolveTemplate` の `missing`）、推測で埋めません。空文字は「空を指定」とみなします。
- 使われている変数は、`replay.valueTemplate`、`annotation.variableName`（値の種別が変数のもの）、置換ルールの `replaceWith` から集めます（`collectUsedVariables`）。
- secret の変数は既定値を保存せず、実行時の値も IndexedDB・`chrome.storage.session` に保存しません（Service Worker のメモリのみ）。

### 再生計画と再生結果 (v2)

- 再生計画（`buildReplayPlan`）は、表示・再生順のうち `replay.skip` でない手順から作ります。`includeInExport` とは独立です。
- 手順の種別ごとの動作: click / input / select / check / key はそのまま、`session-start` は記録開始時の URL へ移動、`reload` は再読み込み。`navigation` / `spa-navigation` は計画の先頭（または直前が操作でない場合）なら移動、直前がクリックなどの操作なら「その操作の結果として起きる遷移」として URL の一致を待ちます（同じ遷移を二重に起こさない）。`wait` は待機だけ。`notice` `manual-capture` `element-note` `session-end` は再生対象外（理由つきで計画に残り、結果は skipped）。
- 機密欄（`value.kind: 'redacted'`）とファイル選択は自動で入力せず `manual`（人が操作して続行）にします。manual の手順は値を一切持ちません。対象要素のセレクターが無い操作も manual です。
- セレクターは、人の指定 → 記録時の一致が 1 件で suspect でない候補 → 一致 1 件で suspect → その他、の順に試します（同順位は記録の順）。再生時に一致が 1 件のものだけを使う前提です。
- 実行前の確認（`preflight`）で、値が決まらない変数（実行時入力が必要な secret の変数を含む）、manual の手順、再生対象外の手順を洗い出します。

ReplayRun（`replayRuns` ストア）:

| 項目 | 内容 |
|---|---|
| `id` `scenarioId` `startedAt` `endedAt` | |
| `status` | `running` `paused` `completed` `failed` `stopped` `interrupted`。`completed` は最後まで実行したことで、業務処理の完了は確認していない |
| `reason` | 停止・失敗・中断の理由 |
| `mode` / `range` / `planStepIds` | `all` `step` `range`、範囲指定、計画に含めた手順 |
| `variableValues` | 変数名ごとに `{provided, secret, value?}`。secret の変数は値を持たない（保存 API が落とす） |
| `results[]` | ReplayStepResult: `stepId` `status`（`ok` `failed` `skipped` `manual` `pending`）`reason` `detail` `selectorUsed` `matchCount`（再生時点）`startedAt` `endedAt` `waitOutcome` |

**`ok` は「操作を実行し、待機条件を観測できた」という意味で、業務処理の完了・成功を意味しません。** failed / skipped は必ず `reason` を持ちます。`reason` `detail` に入力値は書きません。手順を削除しても過去の再生結果は履歴として残ります（参照先のない `stepId` になる）。

#### 再生の実行時の項目（追加分）

| 項目 | 意味（コードのコメントより） |
|---|---|
| `ReplayStepResult.acted` | `ActedState`（`yes` / `possibly` / `no`）。この手順の操作を実行したか。`yes`: 実行した。`possibly`: 実行された可能性がある（応答を受け取れなかった）。`no`: 実行していない。未設定は記録していない（旧データ、または操作を伴わない結果）。再試行で二重操作になり得るかの判断に使う |
| `ReplayStepResult.stoppedWhileRunning` | 停止の要求を受けたときに実行中だった手順。`true` のとき、`reason` に理由がある。ok にも未実行（pending）にもしない |
| `ReplayAction.note` | 再生の仕方についての注記（記録した再読み込みの再生方法など）。UI と結果に表示する |
| `ActiveReplay.actedResume` | 手順が操作済みであることの印（`position` `stepId` `attemptId` `startedAt` ほか）。再開時（SW の再起動後を含む）は操作をせず、待機条件の観測だけを行う。印は `chrome.storage.session` に置くため SW の再起動後も有効。手順の結果が確定したら消す |
| `ActiveReplayWait` の `permission` の `origin` / `originUnknown` | `origin`: 実際にアクセス権が足りないオリジン（UI は `chrome.permissions.request` で要求してから再開する）。`originUnknown`: タブの URL が読めず分からない（`origin` は省略し、UI は任意権限 `<all_urls>` の要求を案内する）。`actedResume`: 操作済みで、再開すると観測だけから続ける |
| 設定 `tracelens.settings` の `lang` | 拡張 UI の表示言語（`ja` が既定、`en`）。`chrome.storage.local` に保存し、記録・出力には影響しない |

`ActiveReplayWait` の `failed-step` は `acted`（`yes` / `possibly` / `no`）を持ちます。`yes` / `possibly` のとき、UI は再試行の前に警告と確認を出します。

### 削除

`deleteStep`（成果物も）、`deleteScenario`（手順・成果物・再生結果も）、`deleteProject`（配下すべて）、`deleteGroup`（子グループと手順を親へ繰り上げ）、`renameProject`。いずれも 1 トランザクションで、残りの手順の `seq` を変えません。

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
- 手順は表示・再生順（`order`）で並べます。ファイル名の `NNNN` と手順番号は元の `seq` のままです。

### v2 で追加した出力項目

- `steps[].artifacts.screenshot.capture`（取得方法 `method` と合成・切り出しの情報 `frameCount` `partial` `partialReason` `cropRect` `elementRectCss` `notes[]`）、`reason`（途中までの場合など）。`steps[].beforeScreenshot`（`status` `path` `basis` `refStepId` `referencedImageCapturedAt` `reason` `note`）。参照先の画像が出力に含まれない場合は `status: 'unavailable'`・`path: null` と理由を出し、壊れた参照を作らない。

`steps.json`（`schemaVersion: 2`）:

| 項目 | 内容 |
|---|---|
| `scenario` | シナリオの名前・目的・前提条件・期待する結果・未確認事項（置換適用済み） |
| `groups[]` | `id` `name` `parentId` `order` `path`（祖先→自分の名前） |
| `variables[]` | `id` `name` `description` `secret` `defaultValue`（secret は null） |
| `latestReplayRun` | 直近の再生（任意。状態・理由・計画に含めた手順・変数名と値が与えられたか）。**変数の値は出力しない** |
| `steps[].group` / `groupPath` / `groupId` | 従来どおりの末端のグループ名と、祖先からのパス |
| `steps[].order` `origin` `importedFrom` | 表示・再生順、由来、取り込み元 |
| `steps[].replay` | 再生設定（値テンプレート・人が指定したセレクター・待機条件など） |
| `steps[].replayResult` | 直近の再生でのこの手順の結果（「再生で観測した結果」。成功の断定ではない） |

Markdown: `scenario.md` はグループの深さに応じた見出し（`###` から。5 段目以降はパスを並べる）と、手順ごとの由来・再生設定・再生で観測した結果を出します。`input-mapping.md` に「シナリオ変数」の表、`README.md` に「再生設定と再生結果」を加えました。`implementation-request.md` の方針は変えていません。

これらはすべて置換を適用したデータモデルから生成します。置換前の値・置換ルールの元の値（正規表現のパターンを含む）・変数の実行時の値・secret の既定値は出力しません。

### 置換ルールの正規表現 (v2)

- `isRegex: true` のとき `find` を正規表現として扱います。フラグは `i` `m` `s` `u` のみ（`g` は常に付ける）。
- 適用の仕組み: データモデル中の文字列（構造項目を除く。HTML 実体参照・URL エンコードを戻した表記を含む）から一致した**具体的な値**を集め、リテラルのルールに展開してから置換します。このため表記ゆれ（生・HTML エスケープ・URL エンコード、生の表記を最優先）と長い値の優先がリテラルと同じになり、残留検査も具体的な値で行えます。正規表現は DOM の HTML 全体（タグ・属性名を含む）にも当たります。
- `replaceWith` は常にリテラルです。`$1` `$&` などの参照は展開しません（置換前の値の一部を出力に戻さないため）。
- 適用しないルール（出力結果の `ruleProblems` と `warnings` に理由を出す）: 構文が不正、空文字に一致する（`a*` や、`\b` のように空の一致を生むものを含む）、許可しないフラグ、後方参照（`\1` `\k<…>`）、繰り返しの入れ子（`(a+)+` など。簡易判定）、パターンが 300 文字超、一致した値が 1,000 文字超、一致した値の種類が 2,000 超。
- 5,000,000 文字を超える文字列には正規表現を当てません（警告を出す。DOM は 3MB で打ち切っているため通常は該当しない）。
- 壊滅的なバックトラックの判定は簡易なもの（入れ子の繰り返しと後方参照の拒否、長さの上限）で、すべての遅いパターンを防げるわけではありません。

### 出力 ZIP の取り込み (v2)

- `parseExportZip` は `steps.json`（必須）、`elements/`（要素の詳細。無ければ `steps.json` の要約から復元し、その旨を `elementCapture` に残す）、`screenshots/`、`dom/`（先頭の TraceLens の注記行は除く）、`manifest.json` を読みます。
- 出力時に除外・取得失敗だった成果物（`path: null`）は未取得（`skipped` / `failed`、理由つき）として扱います。画像は出力時に再エンコード・塗りつぶし済みのものです。
- 値に `{{名前}}` を含む手順は `replay.valueTemplate` に設定し、変数として登録します。置換前の値は ZIP に無いため復元しません。
- ID は再採番し、成果物は `shot_<stepId>` / `dom_<stepId>` の規則に揃えます。グループの入れ子はコピーします（v1 の ZIP では末端の名前からグループを作る）。
- 取り込んだ内容は調査データであり、TraceLens は検証していません（`warnings` で必ず伝える）。展開後の大きさには上限があります（1 ファイル 64MB、合計 512MB、20,000 ファイル）。
