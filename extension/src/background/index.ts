import { EDITOR_TAB_URL_PATH } from '../shared/constants';

async function openOrFocusEditorTab() {
  const url = chrome.runtime.getURL(EDITOR_TAB_URL_PATH);
  const existing = await chrome.tabs.query({ url: `${url}*` });
  if (existing.length > 0 && existing[0].id !== undefined) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId !== undefined) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(() => {
  void openOrFocusEditorTab();
});
