const DEFAULT_SELECTORS = {
  input: [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
    '.ql-editor[contenteditable="true"]'
  ],
  sendBtn: [
    'button[aria-label="Send message"]',
    'button[aria-label*="发送"]',
    'button.send-button'
  ],
  stopBtn: [
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label*="停止"]'
  ],
  responseContainer: [
    'model-response:last-of-type',
    '.conversation-container model-response:last-child'
  ]
};

// ── DOM ───────────────────────────────────────────────────
const dotVscode     = document.getElementById('dot-vscode');
const descVscode    = document.getElementById('desc-vscode');
const dotAI         = document.getElementById('dot-ai');
const descAI        = document.getElementById('desc-ai');
const btnOpenWebAI  = document.getElementById('btn-open-web-ai');
const btnRefresh    = document.getElementById('btn-refresh');
const toggleAdv     = document.getElementById('toggle-advanced');
const advPanel      = document.getElementById('advanced-panel');
const btnLabel      = document.getElementById('btn-label');
const arrowEl       = document.getElementById('arrow');
const selInput      = document.getElementById('sel-input');
const selSend       = document.getElementById('sel-send');
const selStop       = document.getElementById('sel-stop');
const selResponse   = document.getElementById('sel-response');
const btnSaveSel    = document.getElementById('btn-save-selectors');
const btnResetSel   = document.getElementById('btn-reset-selectors');
const saveTip       = document.getElementById('save-tip');

// ── 初始化 ────────────────────────────────────────────────
refreshStatus();
loadSelectors();

// ── 状态刷新 ──────────────────────────────────────────────
function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      setVscodeStatus(false, '连接失败');
      setAIStatus(false, '未知');
      return;
    }
    setVscodeStatus(status.vsConnected, status.vsConnected ? '已连接' : '未连接');
    setAIStatus(!!status.aiTabId, status.aiTabId ? '页面已打开' : '未打开');
  });

  // 同时查询聊天页面的 content script 状态
  chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
    if (tabs.length === 0) {
      setAIStatus(false, '未打开');
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'getStatus' }, (resp) => {
      if (chrome.runtime.lastError) {
        setAIStatus(false, '页面已打开（未就绪）');
        return;
      }
      if (resp) {
        setAIStatus(true, resp.ready ? '已就绪' : '加载中…');
      }
    });
  });
}

function setVscodeStatus(connected, text) {
  dotVscode.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  descVscode.textContent = text;
}

function setAIStatus(open, text) {
  dotAI.className = 'dot ' + (open ? 'connected' : 'disconnected');
  descAI.textContent = text;
}

// 监听 Background 状态变化
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'statusChanged') {
    const { status } = msg;
    setVscodeStatus(status.vsConnected, status.vsConnected ? '已连接' : '未连接');
  }
});

// ── 按钮事件 ──────────────────────────────────────────────
btnOpenWebAI.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'openGemini' });
  window.close();
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.disabled = true;
  btnRefresh.textContent = '刷新中…';
  chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(() => {
    refreshStatus();
    btnRefresh.disabled = false;
    btnRefresh.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg> 刷新状态`;
  }, 1500);
});

// ── 高级配置展开/收起 ─────────────────────────────────────
toggleAdv.addEventListener('click', () => {
  const isHidden = advPanel.classList.toggle('hidden');
  arrowEl.textContent = isHidden ? '▶' : '▼';
  btnLabel.textContent = isHidden ? '⚙ 高级配置（选择器）' : '⚙ 高级配置（更新选择器，逗号分隔）';
});

// ── 选择器加载与保存 ──────────────────────────────────────
function loadSelectors() {
  chrome.storage.local.get('mirrorAiSelectors', ({ mirrorAiSelectors }) => {
    const sel = mirrorAiSelectors || DEFAULT_SELECTORS;
    selInput.value    = toText(sel.input);
    selSend.value     = toText(sel.sendBtn);
    selStop.value     = toText(sel.stopBtn);
    selResponse.value = toText(sel.responseContainer);
  });
}

function toText(arr) {
  return Array.isArray(arr) ? arr.join(',\n') : arr || '';
}

function fromText(text) {
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

btnSaveSel.addEventListener('click', () => {
  const selectors = {
    input:             fromText(selInput.value),
    sendBtn:           fromText(selSend.value),
    stopBtn:           fromText(selStop.value),
    responseContainer: fromText(selResponse.value)
  };

  chrome.runtime.sendMessage({ type: 'updateSelectors', selectors });
  saveTip.classList.remove('hidden');
  setTimeout(() => saveTip.classList.add('hidden'), 2500);
});

btnResetSel.addEventListener('click', () => {
  chrome.storage.local.remove('mirrorAiSelectors');
  selInput.value    = toText(DEFAULT_SELECTORS.input);
  selSend.value     = toText(DEFAULT_SELECTORS.sendBtn);
  selStop.value     = toText(DEFAULT_SELECTORS.stopBtn);
  selResponse.value = toText(DEFAULT_SELECTORS.responseContainer);
  chrome.runtime.sendMessage({ type: 'updateSelectors', selectors: DEFAULT_SELECTORS });
  saveTip.classList.remove('hidden');
  saveTip.textContent = '✓ 已恢复默认选择器';
  setTimeout(() => {
    saveTip.classList.add('hidden');
    saveTip.textContent = '✓ 已保存并同步到页面';
  }, 2500);
});
