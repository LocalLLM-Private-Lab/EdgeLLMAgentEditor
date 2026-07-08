# Copilot DOM セレクタ調査 — 結論: 実装不可能、調査不要

**この調査は打ち切り。DOM注入によるプロンプト挿入・回答キャプチャは Edge では技術的に不可能であることが確認済み。**

## 検証内容(2026-07-08)

Playwrightで実際にEdgeへ拡張機能を読み込み、`https://copilot.microsoft.com/` と `https://m365.cloud.microsoft/` に対して以下の両方式を試した:

1. `chrome.scripting.executeScript()` によるワンショット注入
2. manifestの `content_scripts`(`matches`指定)による宣言的注入

結果、**両方とも一切実行されなかった**。`executeScript`は明示的にエラーを返す:

```
The extensions gallery cannot be scripted.
```

`content_scripts` は静かに無視される(エラーは出ないが、注入したスクリプトの効果(`document.title`書き換え等)が一切反映されない)。

比較として `https://www.microsoft.com/` や `https://example.com/`(host_permissions対象外)は通常の「権限不足」エラーを返しており、上記2ドメインだけが別扱いになっていることを確認した。

## 結論

Edgeは `copilot.microsoft.com` / `m365.cloud.microsoft` を拡張機能ストア相当の保護対象ドメインとして扱っており、**どの注入方式を使っても回避できない**。セレクタの精度や実装方法の問題ではなく、ブラウザレベルの制限。おそらくCopilotへのプロンプトインジェクション攻撃对策として意図的に保護されている。

## 採用した代替方式

- プロンプト作成: `navigator.clipboard.writeText()` でクリップボードにコピー(Copilotのタブには一切触れないため制限の対象外)。ユーザーが手動でCopilotのチャット欄に貼り付けて送信する。
- 回答の取り込み: ユーザーがCopilotの回答を手動でコピーし、拡張機能側のテキストエリアに貼り付ける。DOM読み取りは行わない。

この方式は最初のヒアリングでユーザーが選択肢の一つとして挙げていた「クリップボード貼り付けのみ」に相当し、technicalな制約により現在はこれが唯一実装可能な方式になっている。`extension/src/editor/components/CopilotPanel.tsx` に実装済み。

`chrome.scripting.executeScript`ベースの実装(`background/copilotTabTracker.ts`、`messageRouter.ts`、`injected/`一式)と関連manifest権限(`scripting`、`host_permissions`)は、常に失敗するだけの死んだコードだったため削除済み。
