# アーキテクチャ概要とロードマップ

## 現状(Phase 0〜5 実装済み)

3つの構成要素:

1. **`extension/`** — Edge/Chrome MV3拡張機能(Vite + React + TS + `@crxjs/vite-plugin`)。
   `action` クリックでフルタブのエディタ(`src/editor/index.html`)を開く。Monaco Editorをワーカーごと自前バンドルし、MV3のCSP(remote code / eval禁止)下で動作する。
2. **`terminal-host/`** — Rust製のローカル常駐サーバー(`tokio` + `axum`、`127.0.0.1` のみにバインド)。`portable-pty` でPTYを立ち上げ、WebSocket経由でstdin/stdoutをストリーミングする。ユーザーが手動で起動する運用。
3. File System Access API による直接のローカルファイル編集(ネイティブホスト不要)。

詳細は `docs/protocol.md`(WSプロトコル)を参照。ストア公開は行わない方針のため、審査対応・権限説明文の整備は不要。

## エディタUI

- **ターミナル/Copilotパネルは独立にON/OFF**(表示メニュー、`App.tsx` の `terminalEnabled`/`copilotEnabled`)。両方有効な時だけ切り替えタブが出て、片方だけなら他方はタブ一覧からも消える。非表示中も状態(ターミナルセッション・Copilotへの貼り付け内容)はマウントされたまま保持される。
- **サイドバー幅・下部パネル高さはドラッグでリサイズ可能**(`extension/src/editor/hooks/useResizable.ts`、境界は `ResizeHandle.tsx`)。サイズは `chrome.storage.local` に永続化。
- **拡張子ごとの実行ボタン**: アクティブファイルの拡張子に設定済みコマンドがあればヘッダーに「▶ 実行」が出る(`runCommandStore.ts`)。`{file}` はワークスペースルートからの相対パスに置換される。一意に定まる定番インタプリタ(py/js/ps1/rb/php/pl)のみ初回起動時にデフォルト登録される。設定(「拡張子ごとの実行コマンド...」)から追加・編集・削除可能。

## 設計上の制約(意図的なもの、および技術的制約により確定したもの)

- **Copilotへの自動送信は行わない**: M365の規約リスクを避けるため、プロンプト送信は必ず人間が行う。
- **Copilotタブへのスクリプト注入は一切不可能(検証済み)**: `chrome.scripting.executeScript`・`content_scripts`のどちらを使っても、Edgeは`copilot.microsoft.com`と`m365.cloud.microsoft`を保護対象ドメインとして扱い、あらゆる注入をブロックする(`"The extensions gallery cannot be scripted."`)。詳細は`docs/dom-selectors.md`。これはToS配慮による設計選択ではなく、ブラウザレベルの技術的制約。
  - この発見により、**プロンプト挿入も回答キャプチャも自動化できない**。実装はクリップボードコピー+手動貼り付けのみで構成されている(`extension/src/editor/components/CopilotPanel.tsx`)。
- **FSAハンドルは実パスを持たない**: 過去バージョンではRust側のネイティブフォルダ選択ダイアログでこれを埋め合わせていたが、バックグラウンドで無言に開いたダイアログがブラウザの裏に隠れて「ターミナルが反応しない」実害を招いたため撤去した。現在は `terminal-host` の起動ディレクトリ(`std::env::current_dir()`)をそのままセッションのcwdの既定値として使う(`terminal-host/src/pty_session.rs` の `default_cwd()`)。エディタ側のフォルダと自動で一致させる手段は無いため、必要なら開いたターミナルの中で `cd` する(プロジェクトフォルダの中で `terminal-host` を起動する運用にすればそれも不要になるが必須ではない)。詳細は `docs/protocol.md` の「cwd(作業フォルダ)の扱い」を参照。実行コマンド機能(拡張子ごとのコマンド)も同じ理由から絶対パスではなく相対パス(`{file}` → ワークスペースルートからの相対パス、ターミナルのcwdがワークスペースルートである前提)を使う。
- **拡張機能からのterminal-host起動はNative Messaging経由**: 拡張機能はブラウザのサンドボックス内にあり、OSプロセスを直接起動する手段が無い。唯一の手段がChrome/EdgeのNative Messaging APIで、`terminal-host/install-native-messaging-host.bat`による一度限りのレジストリ登録(`terminal-host.exe`への固定パス、プロジェクトフォルダへのコピーなし)の後、ターミナルパネルの「ターミナルホストを起動」ボタンから起動できる。詳細は`docs/protocol.md`の「Native Messagingによる自動起動」を参照。

## Phase 3 — Copilot連携(クリップボード方式で実装済み)

- `extension/src/editor/copilot/promptTemplates.ts`: アクティブファイル + ユーザーの指示文からプロンプトを生成(「ファイル全体を1コードブロックで返す」よう誘導)。テンプレートは設定(「プロンプトテンプレート...」)からカスタマイズ可能で、プレースホルダー(`{fileName}`/`{instruction}`/`{language}`/`{fileContent}`/`{repoMapSection}`)ベースの単純な置換方式(`promptTemplateStore.ts`、既定値は元のハードコードされていた文言そのまま)。
- `CopilotPanel.tsx`の「クリップボードにコピー」ボタン(`navigator.clipboard.writeText`)でコピーし、ユーザーが手動でCopilotのタブに貼り付けて送信する。
- 回答は同パネルの貼り付け欄にユーザーが手動でペーストし、「コードブロックを解析」ボタンでローカル解析する(DOM読み取りなし、Copilotのタブには一切アクセスしない)。
- manifestに`host_permissions`や`scripting`権限は不要(削除済み)。Copilotのタブに触れる処理が存在しないため。

## Phase 4 — コードへの適用(実装済み)

- `extension/src/editor/copilot/codeBlockParser.ts`: `marked`の`lexer`で貼り付けられた回答からコードブロックを抽出し、直前のテキストからファイルパスらしき候補(inlineコード片)をベストエフォートで推測する。チャット欄全体(```フェンス+説明文)の貼り付けと、コードブロック単体(フェンス無しの生コード、チャットUIの「コピー」ボタン経由など)の貼り付けの両方に対応する。フェンスが1つも見つからない場合は貼り付け全体を1つのコードブロックとして扱うフォールバックを持つ。また、CommonMarkの「4スペースインデントは自動的にコードブロック扱い」というルール(`codeBlockStyle: 'indented'`)による誤検知を除外している — これが無いと、インデントの深いソース(例: Pythonの関数本体)がインデント境界ごとに分断され、インデントの無い行(`def`/`import`など)が抽出結果から丸ごと消えるバグがあった。
- v1は行単位パッチではなく**ファイル全体置換**。`promptTemplates.ts`が「ファイル全体を1コードブロックで返す」よう誘導する。
- `extension/src/editor/components/DiffViewModal.tsx`: `monaco.editor.createDiffEditor`でプレビューし、承認後に`applyToFileFlow.ts`経由で`editorTabsStore.saveFile`(`createWritable()`)を呼んで書き込む。
- `applyToFileFlow.ts`: 適用先ファイルの既存の改行コード(CRLF/LF)を検出し、Copilot側のコード内容をそれに合わせて正規化してから比較・適用する。

## Phase 5 — 仕上げ

- 設定UIの拡充: **実装済み**。拡張子ごとの実行コマンド(`RunCommandSettingsModal.tsx`)とプロンプトテンプレート(`PromptTemplateSettingsModal.tsx`)は設定メニューから編集可能。
- Rustホストの手動更新手順のドキュメント化(v1に自動アップデータはない): 未実装、優先度低。
- ストア公開は行わない方針のため対象外。

## 既知のリスク・制約まとめ

- **Copilot連携は完全手動**(クリップボードコピー&ペースト)。これはブラウザレベルの制約による確定事項であり、将来のEdgeアップデートで注入制限が変わらない限り自動化はできない。
- ユーザーが回答を貼り付ける際、ストリーミング中の不完全な内容を貼り付けてしまう可能性がある(UIガイダンスでは案内しているが技術的な防止策はない)。
- File System Access にファイル監視APIが無いため、外部変更の検知は保存直前の `lastModified` チェックのみ(実装済み、`extension/src/editor/state/editorTabsStore.ts`)。
- コードブロックの適用先ファイルの自動推測(`suggestedPath`)は不正確な可能性があり、ユーザーが選択画面で確認・変更できるようにしている。
