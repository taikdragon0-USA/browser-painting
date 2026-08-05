// Web Draw — background service worker
// 点击扩展图标 → 按需注入/移除绘制层(content.js + content.css)。
// content.js 入口是幂等开关:已有实例则 destroy(关闭),否则 init(开启)。

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (err) {
    // 无法注入的页面:chrome://、应用商店、PDF 等
    console.warn('[Web Draw] 无法在此页面注入绘制层:', err.message);
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#e5484d' });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    }, 2000);
  }
});

// 接收 content script 的状态上报,更新该标签页徽标
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'dw:state') return;
  if (!sender.tab) return;
  if (msg.on) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#2f7bff' });
  } else {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' });
  }
});
