# lsp-host WebSocket プロトコル

`extension` と `lsp-host` は別々のビルドシステムなので、このドキュメントを正として双方の型を手動で同期させる。`terminal-host`/`docs/protocol.md` と同じ構成・同じ接続/認証パターンを踏襲する。

- Rust側の定義: `lsp-host/src/protocol.rs`
- TypeScript側の定義: `extension/src/editor/lsp/lspProtocol.ts`

## 接続

- URL: `ws://127.0.0.1:<port>/ws`（既定ポート `51881`、使用中なら `51882`〜`51884` にフォールバック。固定ポートがすべて使用中なら、OSに割り当てさせたloopback動的ポートへ切り替える。`terminal-host` の `51877`〜`51880` とは別範囲）
- 認証は `terminal-host` と全く同じ:
  - `Origin` ヘッダが起動時に固定した拡張機能ID(`chrome-extension://<id>`)と一致すること
  - トークンは `Sec-WebSocket-Protocol` サブプロトコルとして送る(`new WebSocket(url, [token])`)
  - どちらかが不一致なら `403 Forbidden`
- `GET /health` は認証不要。

## Native Messaging による自動起動・自動接続

`terminal-host` と同じ Native Messaging 起動の仕組みを使うが、1点改良している: レスポンスに `port`/`token` を含める。

- 登録は `node setup/setup.js`(旧`lsp-host/install-native-messaging-host.bat`。`terminal-host`分も含め1つのスクリプトに統合済み)が一度だけ行う。通常は `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.edgellmagenteditor.lsp_host` を使うが、Edgeポリシー `NativeMessagingUserLevelHosts=0`(環境によっては単数形 `NativeMessagingUserLevelHost=0`)を検出した場合はUACで管理者権限を取得し、`HKLM`へ登録する。
- 拡張機能は `{"cmd":"start"}` を送る。`lsp-host/src/native_messaging.rs::handle_start()` は固定ポートと動的ポートの稼働状態を確認し、未起動なら常駐WSサーバを起動して実際にlistenしたポートを待ってから、`{"status":"started"|"already_running","port":..,"token":..}` を返す。別プロセスが固定ポートを占有している場合も、`/health` 応答でlsp-host自身かを確認して誤接続を避ける。
- Native Messaging のレスポンスは呼び出し元の拡張機能にしかブラウザ経由で届かないため、この応答にトークンを含めても外部に漏れない。これにより`terminal-host`のような「表示されたport/tokenを設定画面に手動貼り付け」という手順が不要になり、ブラウザ側は`OpenSession`をそのまま自動送信できる。

同じNative Messagingホストはもう1つのコマンドにも対応する: `{"cmd":"pick_folder"}` を送ると、`handle_pick_folder()` がネイティブのWindowsフォルダ選択ダイアログ(`rfd`クレート)を表示し、`{"status":"picked","path":"C:\\..."}` または(キャンセル時)`{"status":"cancelled"}` を返す。ワークスペースルート訂正機能(下記)のための絶対パス取得手段で、ステータスバーの「フォルダを選択...」ボタンからのみ、ユーザーの明示的なクリックに応じて呼び出される — `terminal-host`で撤去された無言の`pick_workspace_folder`(バックグラウンドで勝手にダイアログを出し、ブラウザの裏に隠れてハングのように見えた)とは異なり、常にユーザー操作の直接の結果として起動するため同じ問題は起きない。

`workspace_root`を明示的に指定しなかった場合、ブラウザ側(`lspStore.ts`の`effectiveWorkspaceRoot`)は上記の個別オーバーライドが無ければ、開いているワークスペース自身の`.m365ce/config`由来の実パス(`workspaceStore.ts`の`workspaceRealPath`。ターミナルパネルの誘導バナーでユーザーが入力し、ワークスペースフォルダ自身に書き込まれる — `docs/protocol.md`の「cwd(作業フォルダ)の扱い」参照)を既定値として使う。個別オーバーライドはモノレポのサブパッケージなど、ターミナルの作業フォルダとLSPのルートを意図的に分けたい場合のための上書き手段として残っている。

## メッセージ(拡張機能 → ホスト、`ClientMessage`)

タグ付きJSON、`type` フィールドで判別(`snake_case`)。

| type | フィールド | 説明 |
|---|---|---|
| `open_session` | `language, workspace_root?` | 指定言語のLSPセッションを開始。対応言語はRust/C/C++/Python/Ruby/HTML/CSS/JavaScript/TypeScript/Verilog/SystemVerilog。`workspace_root` は絶対パス文字列(省略可) |
| `lsp` | `language, payload` | 指定言語の生のLSP JSON-RPCオブジェクト(`initialize`/`textDocument/didOpen`等)。ホストは中身を一切解釈せず、その言語サーバーのstdinへ転送する |
| `restart_session` | `language` | Rustのbuild scriptクラッシュ検知後、同じワークスペースで言語サーバーを再起動する |
| `close_session` | (なし) | 現在のセッションの言語サーバープロセスを終了 |
| `read_file` | `id, uri` | 任意の`file://` URIの内容を読む。言語セッションに紐付かない。`id`は応答との対応付け用。FSAワークスペース外の定義ジャンプ先(Rust/Pythonの標準ライブラリソースなど)をホスト自身のファイルシステムアクセスで読むために存在する |

## メッセージ(ホスト → 拡張機能、`ServerMessage`)

| type | フィールド | 説明 |
|---|---|---|
| `ready` | `language, root_uri` | 指定言語の言語サーバープロセスが起動完了。`root_uri` は選択されたワークスペースルートを `file:///` 形式にしたもの |
| `fetch_progress` | `downloaded, total?` | rust-analyzer未キャッシュ時のダウンロード進捗(バイト単位)。`total` はContent-Lengthが取れない場合`null` |
| `install_progress` | `language, message` | 非Rustの言語サーバーをユーザー領域へ自動導入中。Node/Ruby/OSパッケージマネージャーの処理状況 |
| `fetch_error` | `message` | 自動フェッチ失敗 |
| `lsp` | `language, payload` | 指定言語の言語サーバーstdoutから届いた生のLSP JSON-RPCオブジェクト |
| `process_exited` | `language, code` | 指定言語の言語サーバープロセスの読み取りループがEOFに達した(v1では `code` は常に `null`) |
| `rust_analyzer_build_scripts_crashed` | `language` | rust-analyzerのstderrでbuild scriptワーカーのpanicを検知。拡張機能はbuild script無効でセッションを再起動する |
| `error` | `message` | 上記以外のエラー(未対応言語の指定など) |
| `file_content` | `id, content?, error?` | `read_file`への応答。`content`/`error`のどちらか一方のみセットされる |

## 現在利用できるLSP機能

`lsp-host`はLSPメッセージを解釈せず中継し、以下の機能を拡張機能側のMonacoプロバイダで提供する。ファイル名から決まるMonaco言語IDをそのままLSP言語IDとして使い、対象ファイルを開いた時点で対応するセッションを自動選択する。

- 定義ジャンプ、宣言ジャンプ、実装ジャンプ、型定義ジャンプ
- ホバー説明
- 補完(スニペット、追加テキスト編集、非同期の不完全リストに対応)
- 参照検索(閉じたワークスペースファイルは結果を選択した時点でタブを開く)
- ドキュメントシンボル(アウトライン)
- シグネチャヘルプ(引数ヒント)
- 診断表示(`textDocument/publishDiagnostics`)

定義/宣言/実装/型定義ジャンプ・参照検索の結果がFSAワークスペース外を指す場合(Rust/Pythonの標準ライブラリソース、ワークスペース外にauto-installされたTypeScriptの`lib.d.ts`など)、`read_file`でホストから内容を取得し、保存不可の読み取り専用タブ(`editorTabsStore.ts`の`kind: 'external-text'`)として開く。このタブはLSPセッションには登録されない(`textDocument/didOpen`を送らない)ため、タブ内でのホバー/定義ジャンプは未対応。

### 言語サーバーの対応表

| 言語 | 起動するサーバー | 備考 |
|---|---|---|
| Rust | `rust-analyzer` | 未キャッシュ時はホストが自動取得 |
| C/C++ | `clangd` | PATHを優先。無ければwinget/scoop/choco(Windows)またはbrew(macOS)から自動導入 |
| Python | `pyright-langserver --stdio` または `pylsp` | PATHを優先。無ければnpmのユーザー領域へPyrightを自動導入 |
| Ruby | `solargraph stdio` または `ruby-lsp` | PATHを優先。無ければRubyGemsの`--user-install`で自動導入 |
| HTML | `vscode-html-language-server --stdio` | PATHを優先。無ければnpmのユーザー領域へ自動導入 |
| CSS | `vscode-css-language-server --stdio` | PATHを優先。無ければnpmのユーザー領域へ自動導入 |
| JavaScript/TypeScript | `typescript-language-server --stdio` | PATHを優先。無ければTypeScriptとサーバーをnpmのユーザー領域へ自動導入 |
| Verilog/SystemVerilog | `verible-verilog-ls` または `svlangserver` | PATHを優先。無ければ`@imc-trading/svlangserver`をnpmのユーザー領域へ自動導入 |

MakefileとDockerfileはシンタックスカラーに対応しているが、LSPは未対応。Pythonはプロジェクトルート内の`pyrightconfig.json`/`pyproject.toml`を優先し、`.venv`/`venv`/`env`を自動検出してPyrightへ通知する。

これらはすべて標準のLSPリクエスト/通知であり、ホスト側に個別のメソッド実装は持たない。新しい機能を追加する場合は、`lspStore.ts`のリクエストと`lspProviders.ts`のMonacoプロバイダを対応させ、`initialize`のクライアント能力も必要に応じて更新する。

## rootUri(ワークスペースルート)の扱い

`terminal-host`の cwd 規約(`docs/protocol.md`)と同じ制約から出発するが、実運用で当初の想定が崩れたため`workspace_root`による明示指定を追加した経緯がある(下記参照)。File System Access API には実OSパスを取得する手段が無いため、`lsp-host` は既定では自分自身の起動ディレクトリ(`std::env::current_dir()`)をワークスペースルートとみなす(`ws_server.rs::default_root_dir()`)。バックスラッシュはLSP用URIでは常にフォワードスラッシュへ変換する(`resolveRelativeFilePath.ts`のターミナル実行コマンド用バックスラッシュ規約とは別物、`url`クレートでパーセントエンコードも行う)。`root_uri` は各言語の`Ready`メッセージで返され、以降ブラウザ側はワークスペースツリーの `'/'` 区切り相対パスをこの `root_uri` に連結して `file://` URIを組み立てる。

**当初の想定と実際の問題**: `terminal-host`と同様「プロジェクトのルートフォルダの中で`lsp-host.exe`を起動する運用にすれば自然に一致する」という設計だったが、`lsp-host`はNative Messaging経由で**自動起動**されることが前提(`terminal-host`と異なり、手動起動→ポート/トークンの手動貼り付けという一手間を無くす設計にした)。Native Messagingの自動起動(`native_messaging.rs::spawn_detached()`)は `exe.parent()`(＝`lsp-host.exe`自身が置かれたディレクトリ)をcwdにするため、実際には**ユーザーのプロジェクトと一致しないのが通常のケース**になっていた。

**解決策**: `open_session`に`workspace_root`(絶対パス文字列)を追加し、ブラウザ側から明示的に正しいプロジェクトルートを渡せるようにした。ブラウザ側(`lspStore.ts`)はこの値を`chrome.storage.local`に永続化し、ステータスバーのLSPバッジのポップオーバーから編集できる。値を変更すると、既存のWebSocket接続はそのままに`open_session`を再送し、`lsp-host`側は現在の全言語サーバーをkillしてから新しいrootで再起動する(下記セッションのライフサイクル参照)。`workspace_root`が省略された場合のみ、`default_root_dir()`のcwdフォールバックが使われる。

過去に`terminal-host`で撤去されたネイティブフォルダダイアログ方式(`pick_workspace_folder`)とは異なるアプローチ — バックグラウンドで無言のダイアログを出す代わりに、ステータスバーという常に見える場所にテキスト入力を置くことで、同じ「ブラウザは実パスを知り得ない」制約を解決している。

## セッションのライフサイクル

言語サーバープロセスはWebSocket接続にスコープされる(`terminal-host`のPTYセッションと同じ)。1本のWebSocketに言語ごとのサーバーを多重化する。接続が切れる(タブのリロード等)と、実行中の言語サーバーは`kill`され、再接続後にアクティブだった言語ごとに`open_session`を送り直す(解析インデックスは再構築が必要)。全WebSocket接続が切れた場合は、ブラウザのリロードによる再接続を待つ3秒の猶予後、`lsp-host.exe`自身も終了する。

同一接続内で複数回`open_session`を送った場合:
- 同じ`language`かつ、送られた`workspace_root`(省略時は`default_root_dir()`)が既存セッションのrootと**同じ**なら、`Ready`を再送するだけで新規プロセスは起動しない。
- **異なる**rootなら、全言語の言語サーバーをkillしてから新しいrootで順に起動する(ワークスペースルート訂正機能)。ブラウザ側は古いroot基準のURIで追跡していたドキュメントを全て破棄し、各言語の`Ready`到着後に現在開いている対応ファイルへ`textDocument/didOpen`を送り直す。

## 既知の制約

- Rust以外の言語サーバーはまずユーザー環境のPATHから解決し、未インストールの場合はユーザー領域への自動導入を試みる。Node系には`npm`、Rubyには`gem`、C/C++にはWindowsなら`winget`/`scoop`/`choco`、macOSなら`brew`が必要。LinuxのclangdはOSのパッケージマネージャーで事前導入する必要がある。自動導入の進捗と失敗理由はステータスバーに表示する。
- `workspace_root`を指定しない場合のrootUriはプロセス起動ディレクトリになり、ブラウザ側FSAワークスペースと手動で一致させる必要がある。ステータスバーから絶対パスを指定すれば変更できる。
- WebSocket接続が切れるとプロセスごと終了する(セッション永続化は未対応)。Windowsでは`lsp-host.exe`および言語サーバーをコンソール非表示で起動する。
- Rustの自動フェッチはGitHub Releases APIへの外部HTTPS通信を必要とする(`terminal-host`には無かった新しい能力)。一度キャッシュ済みになれば、以降のRust `open_session`はネットワークアクセスなしでキャッシュ済みバイナリを再利用する(`fetch::find_cached_exe()`)。
