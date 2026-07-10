const WS_PORT            = 8765;
const WS_URL             = `ws://127.0.0.1:${WS_PORT}`;
const RECONNECT_DELAY    = 3000;
const HEARTBEAT_INTERVAL = 20000;

let ws             = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let aiTabId        = null;

// ── 启动 ──────────────────────────────────────────────────
connectWebSocket();

// 保活闹钟（Service Worker 防睡眠）
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') {
    sendHeartbeat();
    if (!ws || ws.readyState !== WebSocket.OPEN) { scheduleReconnect(); }
  }
});

// ── WebSocket 连接 ─────────────────────────────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) { return; }
  clearTimeout(reconnectTimer);
  console.log('[MirrorAi] 正在连接 VSCode:', WS_URL);

  try { ws = new WebSocket(WS_URL); }
  catch (e) { console.error('[MirrorAi] 创建失败:', e); scheduleReconnect(); return; }

  ws.onopen = () => {
    console.log('[MirrorAi] 已连接到 VSCode');
    broadcastStatus();
    startHeartbeat();
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      await handleVSCodeMessage(msg);
    } catch (e) { console.error('[MirrorAi] 消息解析失败:', e); }
  };

  ws.onerror = (err) => { console.warn('[MirrorAi] WS 错误:', err.message || err); };

  ws.onclose = () => {
    console.log('[MirrorAi] VSCode 连接断开');
    ws = null;
    stopHeartbeat();
    broadcastStatus();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, RECONNECT_DELAY);
}

function sendToVSCode(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

// ── 心跳 ──────────────────────────────────────────────────
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }
function sendHeartbeat() { sendToVSCode({ type: 'ping' }); }

// ── 处理来自 VSCode 的消息 ─────────────────────────────────
async function handleVSCodeMessage(msg) {
  console.log('[MirrorAi] VSCode →', msg.type);
  switch (msg.type) {
    case 'hello':
      broadcastStatus();
      break;
    case 'question':
      await dispatchQuestionToAI(msg.data?.prompt || '');
      break;
    case 'newChat':
      await handleNewChat();
      break;
    case 'cancel':
      await handleCancel();
      break;
    default:
      console.warn('[MirrorAi] 未知消息:', msg.type);
  }
}

// ── 发送问题到聊天页面 ─────────────────────────────────────
async function dispatchQuestionToAI(prompt) {
  try {
    const tab = await getAITab();
    aiTabId = tab.id;
    await waitForTabReady(tab.id, 3000);

    // 切换标签页为活跃，使 Gemini 页面 visibilityState 变为 visible，避免回复完成后停止按钮不会消失，导致无法回传
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 500));

    const result = await chrome.tabs.sendMessage(tab.id, { type: 'sendToGemini', prompt });
    if (result?.error) { throw new Error(result.error); }
  } catch (e) {
    console.error('[MirrorAi] 发送失败:', e);
    sendToVSCode({ type: 'error', data: { message: e.message || '发送到聊天页面失败' } });
  }
}

// ── 新建对话 ──────────────────────────────────────────────
async function handleNewChat() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (tabs.length === 0) {
      // 没有标签页，后台新开一个
      const t = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: false });
      aiTabId = t.id;
      return;
    }
    const tab = tabs[0];
    aiTabId = tab.id;

    // 先尝试让 content script 点击"新建"按钮
    chrome.tabs.sendMessage(tab.id, { type: 'newChat' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.clicked) {
        // content script 找不到按钮 → 直接导航到新会话 URL（后台静默）
        chrome.tabs.update(tab.id, { url: 'https://gemini.google.com/app' });
      }
    });
  } catch (e) {
    console.error('[MirrorAi] 新建对话失败:', e);
  }
}

// ── 停止等待 ──────────────────────────────────────────────
async function handleCancel() {
  try {
    if (aiTabId) {
      chrome.tabs.sendMessage(aiTabId, { type: 'cancel' }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (e) {
    console.error('[MirrorAi] 取消失败:', e);
  }
  // 延迟刷新 Gemini 页面，确保后续对话正常
  if (aiTabId) {
    setTimeout(() => {
      chrome.tabs.reload(aiTabId).catch(() => { });
    }, 800);
  }
}

// ── 获取标签页 ─────────────────────────────────────────
async function getAITab() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (tabs.length > 0) {
    return tabs[0];
  }
  // 后台新开，不抢焦点
  const newTab = await chrome.tabs.create({ url: 'https://gemini.google.com/', active: false });
  await waitForTabLoad(newTab.id, 15000);
  return newTab;
}

// 等待 tab 加载完成
function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('标签页加载超时')), timeout);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// 等待 content script 就绪
function waitForTabReady(tabId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    function tryPing() {
      chrome.tabs.sendMessage(tabId, { type: 'ping' }, (resp) => {
        if (chrome.runtime.lastError) { setTimeout(tryPing, 500); }
        else { clearTimeout(timer); resolve(resp); }
      });
    }
    tryPing();
  });
}

// ── 接收 Content Script 消息 ──────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) { aiTabId = sender.tab.id; }

  switch (msg.type) {
    case 'aiResponse':
      sendToVSCode({ type: 'response', data: msg.data });
      sendResponse({ ok: true });
      break;
    case 'aiError':
      sendToVSCode({ type: 'error', data: { message: msg.message } });
      sendResponse({ ok: true });
      break;
    case 'aiStatus':
      sendToVSCode({ type: 'status', data: { aiReady: msg.ready } });
      broadcastStatus();
      sendResponse({ ok: true });
      break;
    case 'getStatus':
      sendResponse(getCurrentStatus());
      break;
    case 'reconnect':
      connectWebSocket();
      sendResponse({ ok: true });
      break;
    case 'openGemini':
      chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, { active: true });
          chrome.windows.update(tabs[0].windowId, { focused: true });
          sendResponse({ ok: true });
        } else {
          chrome.tabs.create({ url: 'https://gemini.google.com/', active: true }, (t) => {
            aiTabId = t.id;
            sendResponse({ ok: true });
          });
        }
      });
      return true;
    case 'updateSelectors':
      chrome.storage.local.set({ aiSelectors: msg.selectors });
      if (aiTabId) {
        chrome.tabs.sendMessage(aiTabId, { type: 'updateSelectors', selectors: msg.selectors });
      }
      sendResponse({ ok: true });
      break;
  }
  return false;
});

// ── 状态 ──────────────────────────────────────────────────
function getCurrentStatus() {
  return { vsConnected: ws?.readyState === WebSocket.OPEN, aiTabId };
}
function broadcastStatus() {
  const status = getCurrentStatus();
  chrome.runtime.sendMessage({ type: 'statusChanged', status }).catch(() => { });
  sendToVSCode({ type: 'status', data: { chromeConnected: true } });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === aiTabId) {
    aiTabId = null;
    sendToVSCode({ type: 'status', data: { aiReady: false } });
  }
});
