# M365 Copilot Code Editor

VSCode 風のエディタを Edge/Chrome 拡張機能(Manifest V3)として実装するプロジェクト。ローカルファイル編集・ターミナル実行・Microsoft 365 Copilot Chat との連携(プロンプト作成はここで行うが、送信は必ずユーザー自身が行う)を目指す。

設計の背景・制約・今後のロードマップは [`docs/architecture.md`](docs/architecture.md) を参照。WebSocket プロトコルの詳細は [`docs/protocol.md`](docs/protocol.md) を参照。

現状の実装範囲(Phase 0〜6): ローカルフォルダを開いて Monaco Editor で編集・保存、Makefile/Dockerfileを含む各種ファイルのシンタックスカラー、Rust 製ローカルサーバー経由のターミナル実行、Rust(rust-analyzer)・C/C++(clangd)・Python・Ruby・HTML・CSS・JavaScript/TypeScript LSPによる定義/宣言/実装/型定義ジャンプ、ホバー、補完、参照検索、アウトライン、引数ヒント、診断表示、Microsoft 365 Copilot との連携(プロンプトのクリップボードコピー、回答の手動貼り付け解析、コードブロックのDiff適用)。LSPは拡張子から言語サーバーを自動選択し、Rust以外もPATHを優先して未導入時はユーザー領域への自動導入を試みる。ターミナル/Copilotパネルは表示メニューから独立にON/OFFでき、サイドバーとパネルの境界はドラッグでリサイズ可能。拡張子ごとの実行コマンドとCopilotへのプロンプトテンプレートは、それぞれ設定メニューからカスタマイズできる(デフォルト値あり)。Copilotパネルには単一ファイル向けの「クイック編集」に加え、複数ファイルにまたがる目標をステップへ分割して1つずつ実行する「計画実行」フローがある(送信・回収は引き続き手動)。

**Copilotタブへの自動プロンプト挿入・自動回答キャプチャは実装していない。** 検証の結果、Edgeは `copilot.microsoft.com` / `m365.cloud.microsoft` へのあらゆる拡張機能スクリプト注入をブラウザレベルでブロックしており(`docs/dom-selectors.md` 参照)、回避不可能なため。プロンプトはクリップボードコピー→手動貼り付け、回答は手動コピー→貼り付け解析という運用になっている。

## 構成

- `extension/` — Vite + React + TypeScript + `@crxjs/vite-plugin` によるMV3拡張機能。
- `terminal-host/` — Rust製のローカル常駐サーバー(`127.0.0.1` のみにバインド)。ターミナル実行のバックエンド。
- `lsp-host/` — Rust製のLSPホスト。拡張機能からNative Messagingで自動起動し、言語サーバーをWebSocket経由で中継する。

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

これは Chrome/Edge の Native Messaging という仕組みを使い、`terminal-host.exe` の**固定パス**を Edge のレジストリに一度だけ登録する。通常はHKCUへの登録で管理者権限は不要だが、Edgeポリシー `NativeMessagingUserLevelHosts=0` の環境ではインストーラがUACで管理者権限を取得してHKLMへ登録する。プロジェクトフォルダへのコピーは発生しない。登録後、ターミナルパネルが切断状態のときに表示される「ターミナルホストを起動」ボタンから起動できる。exe を再ビルド・移動した場合のみ再実行が必要。詳細は `docs/protocol.md` の「Native Messaging による自動起動」を参照。

### 3. LSPホストをセットアップ

LSPの自動起動を有効にするには、`lsp-host.exe`をreleaseビルドしてNative Messagingホストを一度登録する。

```sh
cd lsp-host
cargo build --release
install-native-messaging-host.bat
```

`install-native-messaging-host.bat`は、`target/release/lsp-host.exe`をEdgeへ登録するマニフェストを生成し、通常はユーザー単位のレジストリ(`HKCU`)へ登録する。Edgeポリシー`NativeMessagingUserLevelHosts=0`または`NativeMessagingUserLevelHost=0`を検出した場合は、UACで管理者権限を取得してコンピューター単位(`HKLM`)へ登録する。`lsp-host.exe`の場所を変更した場合は、このバッチを再実行する。

登録後は、次の手順で拡張機能を再読み込みする。

1. `edge://extensions`または`chrome://extensions`を開く。
2. 開発者モードを有効にする。
3. EdgeLLMAgentEditorの「更新」を押す。
4. 対応するソースファイルを開く。

拡張機能がNative Messaging経由で`lsp-host`を自動起動し、既定の固定ポート`51881`へ接続する。固定ポートが使用中の場合は`51882`〜`51884`へ順にフォールバックし、それらも使用中ならloopbackの動的ポートを自動選択するため、ポート番号やトークンを手入力する必要はない。

#### 対応言語と言語サーバー

| 言語 | 言語サーバー | 自動導入 |
|---|---|---|
| Rust | `rust-analyzer` | ホストがユーザー領域へ自動取得 |
| C/C++ | `clangd` | PATH優先。Windowsは`winget`/`scoop`/`choco`、macOSは`brew`を利用 |
| Python | `pyright-langserver` または `pylsp` | npmのユーザー領域へPyrightを導入 |
| Ruby | `solargraph` または `ruby-lsp` | RubyGemsのユーザー領域へ導入 |
| HTML | `vscode-html-language-server` | npmのユーザー領域へ導入 |
| CSS | `vscode-css-language-server` | npmのユーザー領域へ導入 |
| JavaScript/TypeScript | `typescript-language-server` | npmのユーザー領域へTypeScript 5.9.3とともに導入 |

言語サーバーはファイル拡張子から自動選択される。Rust以外はまずPATH上の実行ファイルを探し、見つからない場合に自動導入を試みる。npmを使う言語ではnpm、Rubyではgem、C/C++ではOSに応じたパッケージマネージャーが必要になる。導入先はユーザー領域であり、通常は管理者権限を必要としない。

Python(`.py`/`.pyw`/`.pyi`)とTcl(`.tcl`/`.tk`/`.itcl`)はTextMate文法によるシンタックスカラーに対応している。TclはLSP未対応。

#### ワークスペースルートの指定

Native Messagingで起動した`lsp-host`の作業ディレクトリは、通常プロジェクトフォルダとは異なる。LSPが`node_modules`や設定ファイルを正しく見つけられるよう、ステータスバーのLSP設定からプロジェクトの絶対パスをワークスペースルートとして指定する。TypeScript/JavaScript、Pythonなどのプロジェクト設定を利用する場合は特に指定を推奨する。

#### トラブルシューティング

- `No language server found`が表示される場合は、対象言語のパッケージマネージャーがPATH上で実行できるか確認する。
- TypeScriptで`Could not find a valid TypeScript installation`が表示される場合は、拡張機能を再読み込みして再導入を実行する。自動導入では`typescript-language-server`と互換性のあるTypeScript 5.9.3を使用する。
- `lsp-host.exe`を再ビルドした直後に起動しない場合は、タスクマネージャーで既存の`lsp-host.exe`を終了し、拡張機能を更新する。
- 詳細な接続仕様、Native Messaging、ワークスペースルートの扱いは[`docs/lsp_protocol.md`](docs/lsp_protocol.md)を参照する。

## CI/CD

`.github/workflows/ci.yml`で、push、Pull Request、手動実行時に次のチェックを行う。

- 拡張機能: `oxlint`、TypeScriptの型チェック、Viteプロダクションビルド
- `lsp-host` / `terminal-host`: Rustfmt、Clippy(`-D warnings`)、Unit Test、releaseビルド
- UbuntuとWindowsの両方でRustホストを検証
- 成功した実行では、拡張機能の`dist`と各OSのRust releaseバイナリをActionsのArtifactsへ保存

## 開発時の注意

- `npm run dev`(Vite dev server)でもCRXJSのHMRが使えるが、`background` service worker の変更は手動リロードが必要になることがある。
- Monaco Editor は MV3 の CSP(remote code / eval 禁止)に対応するため、ワーカーを含めて全て自前バンドルしている(`extension/src/editor/monaco/setupMonacoEnvironment.ts`)。
- ターミナルのcwdは `terminal-host` の起動ディレクトリがそのまま使われる。詳細は `docs/protocol.md` の「cwd(作業フォルダ)の扱い」を参照。
