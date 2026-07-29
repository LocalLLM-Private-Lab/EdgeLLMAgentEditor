# M365 Copilot Code Editor

VSCode 風のエディタを Edge/Chrome 拡張機能(Manifest V3)として実装するプロジェクト。ローカルファイル編集・ターミナル実行・Microsoft 365 Copilot Chat との連携(プロンプト作成はここで行うが、送信は必ずユーザー自身が行う)を目指す。

設計の背景・制約・今後のロードマップは [`docs/architecture.md`](docs/architecture.md) を参照。WebSocket プロトコルの詳細は [`docs/protocol.md`](docs/protocol.md) を参照。

現状の実装範囲(Phase 0〜6): ローカルフォルダを開いて Monaco Editor で編集・保存、Makefile/Dockerfileを含む各種ファイルのシンタックスカラー、画像ファイル(png/jpg/gif/webp/bmp/ico/svg/avif)専用ビューア、バイナリらしきファイルを開く前の確認ダイアログ(Open Anyway)、Rust 製ローカルサーバー経由のターミナル実行、Rust(rust-analyzer)・C/C++(clangd)・Python・Ruby・HTML・CSS・JavaScript/TypeScript LSPによる定義/宣言/実装/型定義ジャンプ、ホバー、補完、参照検索、アウトライン、引数ヒント、診断表示、Microsoft 365 Copilot との連携(プロンプトのクリップボードコピー、回答の手動貼り付け解析、コードブロックのDiff適用)、VS Code拡張機能(VSIX)のインストール・実行(下記「拡張機能(VS Code Extensions)対応状況」参照)。LSPは拡張子から言語サーバーを自動選択し、Rust以外もPATHを優先して未導入時はユーザー領域への自動導入を試みる。ターミナル/Copilot/拡張機能Webviewパネルは表示メニューから独立にON/OFFでき、サイドバーとパネルの境界はドラッグでリサイズ可能。拡張子ごとの実行コマンドとCopilotへのプロンプトテンプレートは、それぞれ設定メニューからカスタマイズできる(デフォルト値あり)。Copilotパネルには単一ファイル向けの「クイック編集」に加え、複数ファイルにまたがる目標をステップへ分割して1つずつ実行する「計画実行」フローがある(送信・回収は引き続き手動)。

**Copilotタブへの自動プロンプト挿入・自動回答キャプチャは実装していない。** 検証の結果、Edgeは `copilot.microsoft.com` / `m365.cloud.microsoft` へのあらゆる拡張機能スクリプト注入をブラウザレベルでブロックしており(`docs/dom-selectors.md` 参照)、回避不可能なため。プロンプトはクリップボードコピー→手動貼り付け、回答は手動コピー→貼り付け解析という運用になっている。

## 構成

- `extension/` — Vite + React + TypeScript + `@crxjs/vite-plugin` によるMV3拡張機能。
- `terminal-host/` — Rust製のローカル常駐サーバー(`127.0.0.1` のみにバインド)。ターミナル実行のバックエンド。
- `lsp-host/` — Rust製のLSPホスト。拡張機能からNative Messagingで自動起動し、言語サーバーをWebSocket経由で中継する。

## セットアップ

### 1. セットアップスクリプトを実行

```sh
node setup/setup.js
```

1つのスクリプトで、以下をまとめて行う(旧来の`build-extension.bat`/`terminal-host`・`lsp-host`それぞれの`install-native-messaging-host.bat`を統合したもの。現状Windowsのみ対応、Linux対応は`setup/setup.js`内の`installLinux()`にスタブとして用意されている):

- `extension/`の依存関係インストール(未実行なら)・`npm run build`
- `terminal-host`・`lsp-host`双方の`cargo build --release`
- 両ホストをChrome/EdgeのNative Messagingホストとしてレジストリへ登録(`terminal-host.exe`/`lsp-host.exe`の**固定パス**を一度だけ登録する仕組み。プロジェクトフォルダへのコピーは発生しない)。通常はユーザー単位のレジストリ(`HKCU`)へ登録し管理者権限は不要だが、Edgeポリシー`NativeMessagingUserLevelHosts=0`(または`NativeMessagingUserLevelHost=0`)を検出した場合はUACで管理者権限を取得しコンピューター単位(`HKLM`)へ登録する

完了後、`edge://extensions`(または`chrome://extensions`)で開発者モードを有効にし、「展開して読み込み」で`extension/dist`を選択する(既に読み込み済みなら「更新」)。

各exeを再ビルド・移動した場合は`node setup/setup.js`を再実行する。詳細は`docs/protocol.md`の「Native Messaging による自動起動」を参照。

開発中に拡張機能IDを安定させるための署名鍵 (`extension/.dev-keys/manifest-key.txt`) は既にリポジトリに含まれている。作り直す場合は:

```sh
cd extension/.dev-keys
node generate-dev-key.cjs
```

再生成した場合、出力される `extensionId` を `terminal-host/src/main.rs` の `EXPECTED_EXTENSION_ID` にも反映すること(Originチェックに使われるため)。

#### 開発時: ターミナルホストを手動起動する

`terminal-host`の標準出力をその場で見たい場合など、Native Messagingでの自動起動を経由せず手動で起動することもできる:

```sh
cd terminal-host
cargo run
```

起動時にコンソールへ WebSocket URL・トークン・実際にターミナルが開くディレクトリが表示される。拡張機能のエディタタブでターミナルパネルを開き、ポートとトークンを一度貼り付けると `chrome.storage.local` に保存され、以後自動接続する。

File System Access API にはエディタで開いたフォルダの実OSパスを取得する手段が無い(ブラウザの意図的な制限)ため、ターミナルのcwdをエディタ側のフォルダと自動で一致させることはできない。代わりに、エディタのメニューバー下に表示される案内リボン(またはコマンド入力欄・Ctrl+Pの`>`コマンドモードから「ワークスペースの実パスを登録...」)で、開いているフォルダの実パスを一度だけ入力する。入力した値はterminal-host自身の起動ディレクトリではなく、**今開いているワークスペースフォルダ自身**の中に`.m365ce/config`(実OSパスを記録したJSON)として書き込まれるため、選択ミスによるズレが起きない。次回以降は同じフォルダを開けば自動検出される。未登録の場合は`terminal-host`自身の起動ディレクトリがcwdになるため、開いたターミナルの中で `cd` すればよい(他の一般的なターミナルアプリと同じ操作感)。詳細は`docs/protocol.md`の「cwd(作業フォルダ)の扱い」を参照。

### 2. LSPホストについて

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

上記の案内リボン(またはコマンド入力欄)でワークスペースの実パスを一度登録しておけば、`lsp-host`の作業ディレクトリ(ワークスペースルート)は自動的にそれを継承する — ターミナルと共通の値で、個別に指定する必要はない。モノレポのサブパッケージなど、ターミナルの作業フォルダとLSPのルートを意図的に分けたい場合だけ、ステータスバーのLSP設定から個別に上書きできる。

#### トラブルシューティング

- `No language server found`が表示される場合は、対象言語のパッケージマネージャーがPATH上で実行できるか確認する。
- TypeScriptで`Could not find a valid TypeScript installation`が表示される場合は、拡張機能を再読み込みして再導入を実行する。自動導入では`typescript-language-server`と互換性のあるTypeScript 5.9.3を使用する。
- `lsp-host.exe`を再ビルドした直後に起動しない場合は、タスクマネージャーで既存の`lsp-host.exe`を終了し、拡張機能を更新する。
- 詳細な接続仕様、Native Messaging、ワークスペースルートの扱いは[`docs/lsp_protocol.md`](docs/lsp_protocol.md)を参照する。

## 拡張機能(VS Code Extensions)対応状況

サイドバーの拡張機能タブから`.vsix`(またはpackage.jsonを含む同形のzip)をインストールし、`terminal-host`がNode子プロセスとして実行する(`terminal-host/extension-host/`)。`require('vscode')`を独自シム(`vscode-shim.js`)に差し替える方式で、**実際のVS Codeの互換レイヤーではない**。対応範囲は意図的に絞ってあり、一般的なVS Code拡張機能がそのまま動くとは限らない。

**対応している:**
- `vscode.workspace.fs`(読み書き)、および拡張機能自身が生の Node `fs` を直接使う場合(いずれも実ディスクI/O)
- `vscode.commands.registerCommand`/`executeCommand`
- `vscode.window.show{Information,Warning,Error}Message`・`showOpenDialog`(ネイティブダイアログ)・`showQuickPick`(アプリ内UI)
- `vscode.window.registerWebviewViewProvider`/`createWebviewPanel`(実際に描画・双方向通信でき、表示/非表示の状態(`visible`/`onDidChangeVisibility`/`show()`)も実際のドック表示と同期する)
- `vscode.workspace.getConfiguration()`(設定の読み書き)
- `context.globalState`/`context.workspaceState`(ディスクに永続化。無効化やブラウザの再起動をまたいでも保持される)
- ワークスペースの実パス(下記「ワークスペースルートの指定」と同じ仕組み)を拡張機能プロセスのcwdとして自動的に渡す

**対応していない(呼んでも何も起きないか警告ログのみ):**
- `vscode.languages.*` — ホバー・補完・診断・コードアクションなどの言語プロバイダーAPI全般(このアプリの言語機能は拡張機能とは別系統の`lsp-host`が提供する — 上記参照)
- `vscode.workspace.applyEdit`/`WorkspaceEdit`/`TextEdit`、`activeTextEditor`/`visibleTextEditors`、`openTextDocument` — 標準的なテキストエディタ操作API
- `vscode.window.createTreeView`/`registerTreeDataProvider`(サイドバーのツリービュー)
- `vscode.debug.*`(デバッガー)、`vscode.tasks.*`(タスク)、SCM連携、Notebook API

要するに、「Webviewで自前UIを持ち、ファイルは生fs/`workspace.fs`で直接読み書きし、コマンド登録・通知・設定・状態保存をする」タイプの拡張機能(ローカルLLMエージェント系など)向けに作られたミニマムなシムであり、Prettier/ESLint連携・GitLens・言語系拡張機能・デバッガー拡張・タスクランナー系拡張などは動作しない。

## CI/CD

`.github/workflows/ci.yml`で、push、Pull Request、手動実行時に次のチェックを行う。

- 拡張機能: `oxlint`、TypeScriptの型チェック、Viteプロダクションビルド
- `lsp-host` / `terminal-host`: Rustfmt、Clippy(`-D warnings`)、Unit Test、releaseビルド
- UbuntuとWindowsの両方でRustホストを検証
- 成功した実行では、拡張機能の`dist`と各OSのRust releaseバイナリをActionsのArtifactsへ保存

## 開発時の注意

- `npm run dev`(Vite dev server)でもCRXJSのHMRが使えるが、`background` service worker の変更は手動リロードが必要になることがある。
- Monaco Editor は MV3 の CSP(remote code / eval 禁止)に対応するため、ワーカーを含めて全て自前バンドルしている(`extension/src/editor/monaco/setupMonacoEnvironment.ts`)。
- ターミナル/LSPのcwdは、ワークスペースの実パスを登録済みならそこから、未登録なら各ホスト自身の起動ディレクトリから決まる。詳細は `docs/protocol.md` の「cwd(作業フォルダ)の扱い」を参照。
