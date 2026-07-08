import './WelcomeScreen.css';

interface WelcomeScreenProps {
  needsReconnect: boolean;
  onOpenFolder: () => void;
  onReconnect: () => void;
}

export function WelcomeScreen({ needsReconnect, onOpenFolder, onReconnect }: WelcomeScreenProps) {
  return (
    <div className="welcome-screen">
      <div className="welcome-title">M365 Copilot Code Editor</div>
      {needsReconnect ? (
        <>
          <p className="welcome-text">前回開いていたワークスペースへ再接続できます。</p>
          <button className="welcome-cta" onClick={onReconnect}>
            ワークスペースに再接続
          </button>
        </>
      ) : (
        <>
          <p className="welcome-text">編集を始めるにはフォルダを開いてください。</p>
          <button className="welcome-cta" onClick={onOpenFolder}>
            フォルダを開く
          </button>
        </>
      )}
    </div>
  );
}
