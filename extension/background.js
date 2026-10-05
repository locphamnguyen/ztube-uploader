// Bấm icon extension → mở (hoặc chuyển tới) trang điều khiển uploader.html.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("uploader.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
