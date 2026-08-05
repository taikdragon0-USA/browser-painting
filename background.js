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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;

  // content script 状态上报 → 徽标
  if (msg.type === 'dw:state') {
    if (msg.on) {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#2f7bff' });
    } else {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' });
    }
    return;
  }

  // 导出截图时按需注入 html2canvas 到 content script 的隔离世界
  // (扩展脚本注入不受页面 CSP 限制,也不跨 JS 世界)
  if (msg.type === 'dw:inject-lib') {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        files: ['lib/html2canvas.min.js'],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
    return true; // 异步 sendResponse
  }
});
