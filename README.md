# M365 Copilot Code Editor

VSCode 風のエディタを Edge/Chrome 拡張機能(Manifest V3)として実装するプロジェクト。ローカルファイル編集・ターミナル実行・Microsoft 365 Copilot Chat との連携(プロンプト作成はここで行うが、送信は必ずユーザー自身が行う)を目指す。

設計の背景・制約・今後のロードマップは [`docs/architecture.md`](docs/architecture.md) を参照。WebSocket プロトコルの詳細は [`docs/protocol.md`](docs/protocol.md) を参照。

現状の実装範囲(Phase 0〜5): ローカルフォルダを開いて Monaco Editor で編集・保存、Rust 製ローカルサーバー経由のターミナル実行、Microsoft 365 Copilot との連携(プロンプトのクリップボードコピー、回答の手動貼り付け解析、コードブロックのDiff適用)。ターミナル/Copilotパネルは表示メニューから独立にON/OFFでき、サイドバーとパネルの境界はドラッグでリサイズ可能。拡張子ごとの実行コマンドとCopilotへのプロンプトテンプレートは、それぞれ設定メニューからカスタマイズできる(デフォルト値あり)。

**Copilotタブへの自動プロンプト挿入・自動回答キャプチャは実装していない。** 検証の結果、Edgeは `copilot.microsoft.com` / `m365.cloud.microsoft` へのあらゆる拡張機能スクリプト注入をブラウザレベルでブロックしており(`docs/dom-selectors.md` 参照)、回避不可能なため。プロンプトはクリップボードコピー→手動貼り付け、回答は手動コピー→貼り付け解析という運用になっている。

## 構成

- `extension/` — Vite + React + TypeScript + `@crxjs/vite-plugin` によるMV3拡張機能。
- `terminal-host/` — Rust製のローカル常駐サーバー(`127.0.0.1` のみにバインド)。ターミナル実行のバックエンド。

## セットアップ

### 1. 拡張機能をビルド

```sh
cd extension
npm install
npm run build
```

`dist/` が生成される。`edge://extensions`(または `chrome://extensions`)で開発者モードを有効にし、「展開して読み込み」で `extension/dist` を選択する。

開発中に拡張機能IDを安定させるための署名鍵 (`extension/.dev-keys/manifest-key.txt`) は既にリポジトリに含まれている。作り直す場合は:

```sh
cd extension/.dev-keys
node generate-dev-key.cjs
```

再生成した場合、出力される `extensionId` を `terminal-host/src/main.rs` の `EXPECTED_EXTENSION_ID` にも反映すること(Originチェックに使われるため)。

### 2. ターミナルホスト(Rust)を起動

```sh
cd terminal-host
cargo run
```

起動時にコンソールへ WebSocket URL・トークン・実際にターミナルが開くディレクトリが表示される。拡張機能のエディタタブでターミナルパネルを開き、ポートとトークンを一度貼り付けると `chrome.storage.local` に保存され、以後自動接続する。

ターミナルの作業フォルダ(cwd)は、このプロセス自身の起動ディレクトリがそのまま使われる。File System Access API にはエディタで開いたフォルダの実OSパスを取得する手段が無い(ブラウザの意図的な制限、詳細は `docs/protocol.md`)ため、エディタ側のフォルダと自動で一致させることはできない。**普段は開いたターミナルの中で `cd` すればよい**(他の一般的なターミナルアプリと同じ操作感)。もし起動ディレクトリを毎回プロジェクトフォルダに合わせたければ、そのフォルダの中で `terminal-host.exe` を起動する運用にすれば `cd` すら不要になるが、必須ではない。

#### 2b. (任意)拡張機能からの自動起動を有効化

毎回手動で `cargo run`/`terminal-host.exe` を起動したくない場合、拡張機能側の「ターミナルホストを起動」ボタンから起動できるようにする一度限りのセットアップ:

```sh
cd terminal-host
cargo build --release
install-native-messaging-host.bat
```

これは Chrome/Edge の Native Messaging という仕組みを使い、`terminal-host.exe` の**固定パス**を Edge のレジストリ(`HKCU`、管理者権限不要)に一度だけ登録する。プロジェクトフォルダへのコピーは発生しない。登録後、ターミナルパネルが切断状態のときに表示される「ターミナルホストを起動」ボタンから起動できる。exe を再ビルド・移動した場合のみ再実行が必要。詳細は `docs/protocol.md` の「Native Messaging による自動起動」を参照。

## 開発時の注意

- `npm run dev`(Vite dev server)でもCRXJSのHMRが使えるが、`background` service worker の変更は手動リロードが必要になることがある。
- Monaco Editor は MV3 の CSP(remote code / eval 禁止)に対応するため、ワーカーを含めて全て自前バンドルしている(`extension/src/editor/monaco/setupMonacoEnvironment.ts`)。
- ターミナルのcwdは `terminal-host` の起動ディレクトリがそのまま使われる。詳細は `docs/protocol.md` の「cwd(作業フォルダ)の扱い」を参照。
