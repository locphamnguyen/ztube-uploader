// Bấm icon extension (hoặc nút "Trang điều khiển" trên bảng nổi ở Studio) → mở (hoặc chuyển tới) trang điều khiển uploader.html.
async function openUploader() {
  const url = chrome.runtime.getURL("uploader.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(openUploader);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "open-uploader") openUploader();
});
