# lsp-host WebSocket プロトコル

`extension` と `lsp-host` は別々のビルドシステムなので、このドキュメントを正として双方の型を手動で同期させる。`terminal-host`/`docs/protocol.md` と同じ構成・同じ接続/認証パターンを踏襲する。

- Rust側の定義: `lsp-host/src/protocol.rs`
- TypeScript側の定義: `extension/src/editor/lsp/lspProtocol.ts`

## 接続

- URL: `ws://127.0.0.1:<port>/ws`(既定ポート `51881`、使用中なら `51882`〜`51884` にフォールバック。`terminal-host` の `51877`〜`51880` とは別範囲)
- 認証は `terminal-host` と全く同じ:
  - `Origin` ヘッダが起動時に固定した拡張機能ID(`chrome-extension://<id>`)と一致すること
  - トークンは `Sec-WebSocket-Protocol` サブプロトコルとして送る(`new WebSocket(url, [token])`)
  - どちらかが不一致なら `403 Forbidden`
- `GET /health` は認証不要。

## Native Messaging による自動起動・自動接続

`terminal-host` と同じ Native Messaging 起動の仕組みを使うが、1点改良している: レスポンスに `port`/`token` を含める。

- 登録は `lsp-host/install-native-messaging-host.bat` が一度だけ行う(`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.edgellmagenteditor.lsp_host`)。
- 拡張機能は `{"cmd":"start"}` を送る。`lsp-host/src/native_messaging.rs::handle_start()` は `config::load_or_create()` で永続化済みのport/tokenを読み(常駐WSサーバも同じファイルを読む)、`{"status":"started"|"already_running","port":..,"token":..}` を返す。
- Native Messaging のレスポンスは呼び出し元の拡張機能にしかブラウザ経由で届かないため、この応答にトークンを含めても外部に漏れない。これにより`terminal-host`のような「表示されたport/tokenを設定画面に手動貼り付け」という手順が不要になり、ブラウザ側は`OpenSession`をそのまま自動送信できる。

同じNative Messagingホストはもう1つのコマンドにも対応する: `{"cmd":"pick_folder"}` を送ると、`handle_pick_folder()` がネイティブのWindowsフォルダ選択ダイアログ(`rfd`クレート)を表示し、`{"status":"picked","path":"C:\\..."}` または(キャンセル時)`{"status":"cancelled"}` を返す。ワークスペースルート訂正機能(下記)のための絶対パス取得手段で、ステータスバーの「フォルダを選択...」ボタンからのみ、ユーザーの明示的なクリックに応じて呼び出される — `terminal-host`で撤去された無言の`pick_workspace_folder`(バックグラウンドで勝手にダイアログを出し、ブラウザの裏に隠れてハングのように見えた)とは異なり、常にユーザー操作の直接の結果として起動するため同じ問題は起きない。

## メッセージ(拡張機能 → ホスト、`ClientMessage`)

タグ付きJSON、`type` フィールドで判別(`snake_case`)。

| type | フィールド | 説明 |
|---|---|---|
| `open_session` | `language, workspace_root?` | 指定言語のLSPセッションを開始。今回は `"rust"` のみサポート。`workspace_root` は絶対パス文字列(省略可) |
| `lsp` | `payload` | 生のLSP JSON-RPCオブジェクト(`initialize`/`textDocument/didOpen`等)。ホストは中身を一切解釈せず、そのまま言語サーバーのstdinへ転送する |
| `close_session` | (なし) | 現在のセッションの言語サーバープロセスを終了 |

## メッセージ(ホスト → 拡張機能、`ServerMessage`)

| type | フィールド | 説明 |
|---|---|---|
| `ready` | `root_uri` | 言語サーバープロセスが起動完了(既存プロセスの再利用時も含む)。`root_uri` はこのホスト自身の起動ディレクトリを `file:///` 形式にしたもの |
| `fetch_progress` | `downloaded, total?` | rust-analyzer未キャッシュ時のダウンロード進捗(バイト単位)。`total` はContent-Lengthが取れない場合`null` |
| `fetch_error` | `message` | 自動フェッチ失敗 |
| `lsp` | `payload` | 言語サーバーのstdoutから届いた生のLSP JSON-RPCオブジェクト |
| `process_exited` | `code` | 言語サーバープロセスの読み取りループがEOFに達した(v1では `code` は常に `null` — `terminal-host`の`exited`と同じ理由) |
| `error` | `message` | 上記以外のエラー(未対応言語の指定など) |

## 現在利用できるLSP機能

`lsp-host`はLSPメッセージを解釈せず中継し、以下の機能を拡張機能側のMonacoプロバイダで提供する。対象は現在Rust(`rust-analyzer`)のみ。

- 定義ジャンプ、宣言ジャンプ、実装ジャンプ、型定義ジャンプ
- ホバー説明
- 補完(スニペット、追加テキスト編集、非同期の不完全リストに対応)
- 参照検索(閉じたワークスペースファイルは結果を選択した時点でタブを開く)
- ドキュメントシンボル(アウトライン)
- シグネチャヘルプ(引数ヒント)
- 診断表示(`textDocument/publishDiagnostics`)

これらはすべて標準のLSPリクエスト/通知であり、ホスト側に個別のメソッド実装は持たない。新しい機能を追加する場合は、`lspStore.ts`のリクエストと`lspProviders.ts`のMonacoプロバイダを対応させ、`initialize`のクライアント能力も必要に応じて更新する。

## rootUri(ワークスペースルート)の扱い

`terminal-host`の cwd 規約(`docs/protocol.md`)と同じ制約から出発するが、実運用で当初の想定が崩れたため`workspace_root`による明示指定を追加した経緯がある(下記参照)。File System Access API には実OSパスを取得する手段が無いため、`lsp-host` は既定では自分自身の起動ディレクトリ(`std::env::current_dir()`)をワークスペースルートとみなす(`ws_server.rs::default_root_dir()`)。バックスラッシュはLSP用URIでは常にフォワードスラッシュへ変換する(`resolveRelativeFilePath.ts`のターミナル実行コマンド用バックスラッシュ規約とは別物、`url`クレートでパーセントエンコードも行う)。`root_uri` は `Ready` メッセージで一度だけ返され、以降ブラウザ側はワークスペースツリーの `'/'` 区切り相対パスをこの `root_uri` に連結して `file://` URIを組み立てる。

**当初の想定と実際の問題**: `terminal-host`と同様「Rustプロジェクトのルートフォルダの中で`lsp-host.exe`を起動する運用にすれば自然に一致する」という設計だったが、`lsp-host`はNative Messaging経由で**自動起動**されることが前提(`terminal-host`と異なり、手動起動→ポート/トークンの手動貼り付けという一手間を無くす設計にした)。Native Messagingの自動起動(`native_messaging.rs::spawn_detached()`)は `exe.parent()`(＝`lsp-host.exe`自身が置かれたディレクトリ)をcwdにするため、実際には**ユーザーのRustプロジェクトと一致しないのが通常のケース**になってしまっていた(rust-analyzerはCargo.tomlを見つけられずインデックスが空になり、hover/definitionが常に無言で空を返す — エラーにはならないため症状が分かりにくい)。

**解決策**: `open_session`に`workspace_root`(絶対パス文字列)を追加し、ブラウザ側から明示的に正しいプロジェクトルートを渡せるようにした。ブラウザ側(`lspStore.ts`)はこの値を`chrome.storage.local`に永続化し、ステータスバーのLSPバッジのポップオーバーから編集できる。値を変更すると、既存のWebSocket接続はそのままに`open_session`を再送し、`lsp-host`側は現在のrust-analyzerプロセスをkillしてから新しいrootで再起動する(下記セッションのライフサイクル参照)。`workspace_root`が省略された場合のみ、`default_root_dir()`のcwdフォールバックが使われる。

過去に`terminal-host`で撤去されたネイティブフォルダダイアログ方式(`pick_workspace_folder`)とは異なるアプローチ — バックグラウンドで無言のダイアログを出す代わりに、ステータスバーという常に見える場所にテキスト入力を置くことで、同じ「ブラウザは実パスを知り得ない」制約を解決している。

## セッションのライフサイクル

言語サーバープロセスはWebSocket接続にスコープされる(`terminal-host`のPTYセッションと同じ)。接続が切れる(タブのリロード等)と、実行中のrust-analyzerプロセスは`kill`され、再接続後の最初の`open_session`で新規に起動し直す(解析インデックスは再構築が必要)。

同一接続内で複数回`open_session`を送った場合:
- 送られた`workspace_root`(省略時は`default_root_dir()`)が既存セッションのrootと**同じ**なら、`Ready`を再送するだけで新規プロセスは起動しない。
- **異なる**なら、既存のrust-analyzerプロセスをkillしてから新しいrootで新規プロセスを起動する(ワークスペースルート訂正機能 — 上記参照)。ブラウザ側は古いroot基準のURIで追跡していたドキュメントを全て破棄し、新しい`Ready`到着後に現在開いている`.rs`タブ全てへ`textDocument/didOpen`を送り直す(`editorTabsStore.ts`の`useLspStore.subscribe(...)`)。

## 既知の制約

- 対応言語は現状 `rust`(rust-analyzer)のみ。`language`フィールド自体は将来の多言語対応を見据えて用意してあるが、`lsp-host`側は`rust`以外を`error`で拒否する。
- rootUriは`terminal-host`と同じくプロセス起動ディレクトリに固定され、ブラウザ側FSAワークスペースと手動で一致させる必要がある。
- WebSocket接続が切れるとプロセスごと終了する(セッション永続化は未対応)。
- 自動フェッチはGitHub Releases APIへの外部HTTPS通信を必要とする(`terminal-host`には無かった新しい能力)。一度キャッシュ済みになれば、以降の`open_session`はネットワークアクセスなしでキャッシュ済みバイナリを再利用する(`fetch::find_cached_exe()`)。
