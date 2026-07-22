# terminal-host WebSocket プロトコル

`extension` と `terminal-host` は別々のビルドシステムなので、このドキュメントを正として双方の型を手動で同期させる。

- Rust側の定義: `terminal-host/src/protocol.rs`
- TypeScript側の定義: `extension/src/editor/terminal/terminalProtocol.ts`

## 接続

- URL: `ws://127.0.0.1:<port>/ws`(既定ポート `51877`、使用中なら `51878`〜`51880` にフォールバック)
- 認証:
  - `Origin` ヘッダが起動時に固定した拡張機能ID(`chrome-extension://<id>`)と一致すること
  - ブラウザの `WebSocket` API はカスタムヘッダを送れないため、トークンは `Sec-WebSocket-Protocol` サブプロトコルとして送る(`new WebSocket(url, [token])`)
  - どちらかが不一致なら `403 Forbidden` でアップグレードを拒否する
- `GET /health` は認証不要。起動確認用。

## メッセージ(拡張機能 → ホスト、`ClientMessage`)

タグ付きJSON、`type` フィールドで判別(`snake_case`)。

| type | フィールド | 説明 |
|---|---|---|
| `open_session` | `session_id, cwd?, cols, rows, shell?` | PTYセッションを開始 |
| `stdin` | `session_id, data` | `data` はbase64エンコードされた生バイト列 |
| `resize` | `session_id, cols, rows` | ターミナルのリサイズ |
| `close` | `session_id` | セッションを終了 |

## メッセージ(ホスト → 拡張機能、`ServerMessage`)

| type | フィールド | 説明 |
|---|---|---|
| `session_opened` | `session_id, pid` | セッション開始完了 |
| `stdout` | `session_id, data` | base64エンコードされたPTY出力 |
| `exited` | `session_id, exit_code` | プロセス終了(v1では `exit_code` は常に `null` — reader threadのEOF検知のみで、`child.wait()` によるステータス取得は未実装) |
| `error` | `session_id?, message` | エラー通知 |

## cwd(作業フォルダ)の扱い

File System Access API(拡張機能がエディタでフォルダを開くのに使う仕組み)には、実OS上のパスを取得する手段が一切ない(ブラウザの意図的な制限)。そのため拡張機能は `open_session` の `cwd` を基本的に**送らない**。

代わりに、`terminal-host` は自分自身が起動されたディレクトリ(`std::env::current_dir()`)を新規セッションのcwdの既定値として使う(`pty_session.rs` の `default_cwd()`)。エディタ側のフォルダと自動で一致させる手段は無いため、必要ならユーザーが開いたターミナルの中で `cd` すればよい(他の一般的なターミナルアプリと同じ操作感)。プロジェクトフォルダの中で `terminal-host.exe` を起動する運用にすれば `cd` すら不要になるが、あくまで任意の最適化であり必須ではない。取得に失敗した場合のみシステムドライブのルート(例: `C:\`)にフォールバックする。

過去バージョンではネイティブフォルダダイアログでこの実パスを都度確認させる `pick_workspace_folder`/`workspace_folder_picked` メッセージがあったが、バックグラウンドで無言で開いたダイアログがブラウザの裏に隠れて気づかれず「ターミナルが応答しない」ように見える実害があったため撤去した。

## Native Messaging による自動起動

拡張機能はブラウザのサンドボックス内で動くため、`fetch` や DOM API では OS プロセス(`terminal-host.exe`)を起動できない。唯一の手段が Chrome/Edge の **Native Messaging API**(`chrome.runtime.sendNativeMessage`)で、拡張機能から登録済みのネイティブ実行ファイルを起動できる。

- 登録は `terminal-host/install-native-messaging-host.bat` が一度だけ行う。通常は `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.m365copilot.terminal_host_launcher` に登録するが、Edgeポリシー `NativeMessagingUserLevelHosts=0` を検出した場合はUACで管理者権限を取得し、`HKLM`へ登録する。マニフェストJSONは実行ファイルへの固定パスを持ち、プロジェクトフォルダへのコピーは発生しない。プロジェクトとは無関係の一回限りの設定。
- 拡張機能は `terminal-host/src/native_messaging.rs` に実装された `terminal-host.exe` 自身に `{"cmd":"start"}` を送る。ブラウザは Native Messaging ホストを起動する際、呼び出し元拡張機能のoriginを `argv[1]`(例: `chrome-extension://<id>/`)として渡すため、`main.rs` はこれを見て「Native Messaging経由の起動」を「通常起動」と区別する。
- Native Messaging モードでは: (1) 既にWSサーバがどれかのポートで listen 中なら `already_running` を返して終了、(2) そうでなければ自分自身(`terminal-host.exe`)を `DETACHED_PROCESS` フラグ付きで再起動し、`started` を返して終了する。この再起動されたプロセスは通常起動と全く同じ(cwdは自分の実行ファイルのあるディレクトリ、WSサーバを起動して常駐)であり、Native Messaging の接続(ブラウザ側の寿命管理)には紐付かない。

## 既知の制約

- stdin/stdoutはUTF-8を仮定せずbase64で運ぶ(PTY出力はUTF-8保証がないため)。
- PTYセッションはWebSocket接続単位のスコープ。タブ/接続を閉じると紐づくセッションは全て終了する(再接続をまたいだセッション永続化は未対応)。
