# TraceLens

**操作と意図を、実装につなぐ** — ブラウザ操作の調査・記録ツール（プロトタイプ v0.1.0）

人間がブラウザで行った操作を、対象要素・画面構造（DOM）・操作後の画面・観測時刻・人間が書いた意図や成功条件と関連づけて保存し、AIコーディングに渡せるZIPとして出力する Chromium 向け拡張機能（Manifest V3）です。

- 記録はすべてブラウザ内（IndexedDB）に保存し、**外部へ送信しません**。外部API・外部フォントも使いません。
- 記録するのは、**ユーザーが記録を開始した1つのタブだけ**です。
- 自動再生、Selenium コード生成、AI API 連携、クラウド同期、認証、チーム共有は対象外です（収集側と、成果物を使う自動化技術は分離しています）。

| ドキュメント | 内容 |
|---|---|
| [docs/guide.md](docs/guide.md) | 最初の調査を行う操作ガイド |
| [docs/data-format.md](docs/data-format.md) | データ形式と実装構成 |
| [docs/verification.md](docs/verification.md) | 実施した検証結果（確認済み／未確認の区別） |
| [docs/decisions.md](docs/decisions.md) | 設計判断の記録、既知の制限、未実装項目 |
| [CLAUDE.md](CLAUDE.md) | 開発に参加する人・コーディングエージェント向けの目的、原則、品質基準 |
| [docs/sample-export.zip](docs/sample-export.zip) | 模擬業務ページの記録から生成した出力ZIPの実例 |

## 現在の状態

プロトタイプです。Linux 上の Chromium 153 で、模擬業務ページに対する「記録 → レビュー → ZIP出力」を自動検証しています（単体テスト 32 件、通し検証 63 項目、配布用ビルドの権限フロー 11 項目）。**Microsoft Edge、Google Chrome 安定版、Windows / macOS の実機では未確認です。** 詳細と実機での確認手順は [docs/verification.md](docs/verification.md) を参照してください。

## 1. 開発・ビルド

必要環境: Node.js 20 以上（22 で確認）。

```bash
git clone https://github.com/Hoyuma/TraceLens.git
```

```bash
cd TraceLens
```

```bash
npm install
```

```bash
npm run build
```

`dist/` に拡張機能一式が生成されます。

| コマンド | 内容 |
|---|---|
| `npm run build` | 配布用ビルド（`dist/`） |
| `npm run typecheck` | 型検査 |
| `npm test` | 単体テスト（入力の集約、機密値の除外、セレクター、エクスポート、保存） |
| `npm run mock` | 模擬業務ページを起動（http://127.0.0.1:4173/login.html） |
| `npm run e2e` | 実ブラウザでの通し検証（テスト用ビルド `dist-e2e/` を使用。Playwright と Chromium が必要） |
| `npm run verify:real-permissions` | 配布用ビルドの権限フロー検証（Linux + Xvfb + python3 + ImageMagick が必要） |

`dist-e2e/` は自動テスト専用で、`host_permissions: <all_urls>` を事前付与しています（ツールバーアイコンのクリックを自動化できないため）。**利用者には `dist/` を導入してください。**

## 2. Edge / Chrome への導入

Chrome 116 以降、または同等の Chromium 系 Edge を想定しています。

1. `npm run build` を実行する。
2. 拡張機能の管理ページを開く。Chrome: `chrome://extensions` / Edge: `edge://extensions`
3. 「デベロッパー モード」（Edge は「開発者モード」）をオンにする。
4. 「パッケージ化されていない拡張機能を読み込む」（Edge は「展開して読み込み」）で `dist` フォルダーを選ぶ。
5. ツールバーの拡張機能メニュー（パズルのアイコン）から TraceLens をピン留めする。

要求する権限は `activeTab` / `scripting` / `sidePanel` / `storage` / `unlimitedStorage` のみで、インストール時にサイトへのアクセス権は要求しません。更新時は `npm run build` の後、拡張機能の管理ページで再読み込みしてください（記録中のセッションは「中断」になりますが、保存済みの記録は残ります）。

## 3. 模擬業務ページ

実際の業務システムがなくても試せる、小さな模擬ページを `mock-site/` に同梱しています（TraceLens 本体とは独立。本体側に勤怠固有のロジックはありません）。

```bash
npm run mock
```

http://127.0.0.1:4173/login.html を開きます。対象日、PJ 選択、PJ に応じて遅れて更新される工程選択、工数入力、行追加、保存と完了メッセージ、必須入力エラー、登録済みデータの再表示、SPA 形式の画面切り替え、パスワード欄、同一オリジン iframe、open Shadow DOM を含みます。

## 4. 使い方（概要）

1. 記録したいタブを表示し、ツールバーの **TraceLens アイコンをクリック**（サイドパネルが開き、そのタブへのアクセスが許可されます）。
2. パネルでプロジェクトとシナリオを作成し、「記録を開始」。
3. 普段どおり操作する。必要に応じて「画面を保存」「要素を選んで注記」、直前の操作へのメモ。
4. 「一時停止／再開／終了」。
5. 「レビュー画面を開く」で確認・注記・除外・塗りつぶし → 「AI向けZIPを出力…」。

詳しくは [docs/guide.md](docs/guide.md) を参照してください。

## 5. 既知の制限（要点）

- **別オリジンへ遷移すると権限が失効します。** パネルに「記録が中断しています」と表示され、通知ステップが残ります。対象タブで TraceLens アイコンをクリックするか `Alt+Shift+S` を押すと継続します。失効中の操作は記録されません。複数オリジンをまたぐ調査では、パネルの「アクセス権について」から全サイトへのアクセスを任意で許可できます。
- 新しいタブ・別ウィンドウへの記録継続は未対応です（発生時は通知ステップとして記録）。
- 画像は表示領域のみ。ページ全体のキャプチャは未対応です。
- クロスオリジン iframe（権限のないもの）、closed Shadow DOM、canvas の内部、ブラウザ内部ページは取得できません。
- 画像内の文字は自動でマスクされません。出力前に人間が確認してください。

全体は [docs/decisions.md](docs/decisions.md) を参照してください。

## ライセンス

[MIT License](LICENSE)
