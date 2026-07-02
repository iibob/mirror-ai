(function () {
  'use strict';

  let SELECTORS = {
    input: [
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    sendBtn: [
      'button[aria-label="Send message"]',
      'button[aria-label*="发送"]',
      'button.send-button',
      'button[jsname="hRZeKc"]',
      'button[type="submit"]'
    ],
    stopBtn: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="stop" i]',
      'button[jsname="l4Nn6e"]'
    ],
    newChatBtn: [
      'button[aria-label="New chat"]',
      'button[aria-label*="new chat" i]',
      'button[aria-label*="新对话"]',
      'button[aria-label*="新建"]',
      'a[href="/app"]',
      'button[data-test-id="new-chat-button"]'
    ],
    responseContainerAll: [
      'model-response',
      'response-container',
      '[data-response-index]'
    ],
    responseText: [
      '.model-response-text',
      '.response-container-content',
      'message-content .markdown',
      '.markdown'
    ]
  };

  chrome.storage.local.get('mirrorAiSelectors', ({ mirrorAiSelectors }) => {
    if (mirrorAiSelectors) { SELECTORS = Object.assign({}, SELECTORS, mirrorAiSelectors); }
  });

  // ── 工具 ──────────────────────────────────────────────────
  function findEl(selectorList, root = document) {
    for (const sel of selectorList) {
      try { const el = root.querySelector(sel); if (el) { return el; } } catch { /* skip */ }
    }
    return null;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function countExistingResponses() {
    for (const sel of SELECTORS.responseContainerAll) {
      try {
        const n = document.querySelectorAll(sel).length;
        if (n > 0) { return { sel, count: n }; }
      } catch { /* skip */ }
    }
    return { sel: SELECTORS.responseContainerAll[0], count: 0 };
  }

  // ── 写入输入框 ─────────────────────────────────────────────
  async function writeToInput(input, text) {
    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    input.click();
    input.focus();
    await sleep(150);

    const sel   = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(80);

    const ok = document.execCommand('insertText', false, text);

    if (!ok || !input.textContent.trim()) {
      sel.removeAllRanges();
      input.innerHTML = '';
      input.focus();
      await sleep(50);
      document.execCommand('insertText', false, text);
    }
    if (!input.textContent.trim()) {
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await sleep(300);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    await sleep(200);
  }

  // ── 发送到 Gemini ─────────────────────────────────────────
  async function sendToGemini(prompt) {
    let input = null;
    for (let i = 0; i < 20; i++) {
      input = findEl(SELECTORS.input);
      if (input) { break; }
      await sleep(500);
    }
    if (!input) {
      throw new Error('找不到 Gemini 输入框，请确认页面已完全加载并已登录，或在插件高级配置中更新选择器');
    }

    const before = countExistingResponses();
    await writeToInput(input, prompt);

    if (!(input.textContent || '').trim()) {
      throw new Error('文本写入输入框失败，请在插件高级配置中更新选择器');
    }

    let sendBtn = null;
    for (let i = 0; i < 20; i++) {
      sendBtn = findEl(SELECTORS.sendBtn);
      if (sendBtn && !sendBtn.disabled && !sendBtn.hasAttribute('disabled')) { break; }
      sendBtn = null;
      await sleep(300);
    }

    if (sendBtn) {
      sendBtn.click();
    } else {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true
      }));
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, composed: true
      }));
    }

    await sleep(600);
    return await waitForResponse(before);
  }

  async function waitForResponse(before, timeout = 120000) {
    const start = Date.now();
    let started = false;

    while (Date.now() - start < 15000) {
      if (findEl(SELECTORS.stopBtn)) { started = true; break; }
      const cur = document.querySelectorAll(before.sel).length;
      if (cur > before.count) { started = true; break; }
      await sleep(400);
    }

    if (!started) {
      await sleep(1500);
      const cur = document.querySelectorAll(before.sel).length;
      if (cur <= before.count) {
        throw new Error('Gemini 未开始响应，请检查：①已登录 ②Gemini 页面正常 ③选择器配置正确');
      }
    }

    while (Date.now() - start < timeout) {
      if (!findEl(SELECTORS.stopBtn)) { break; }
      await sleep(500);
    }

    await sleep(1200);
    return extractLatestResponse(before);
  }

  function extractLatestResponse(before) {
    let targetEl = null;
    for (const sel of SELECTORS.responseContainerAll) {
      try {
        const all = document.querySelectorAll(sel);
        if (all.length > 0) {
          targetEl = all[all.length - 1];
          break;
        }
      } catch { /* skip */ }
    }

    if (!targetEl) {
      return { markdown: '（未能提取回复内容，请在插件高级配置中更新「回复容器选择器」）', text: '', isHtml: false };
    }

    const textEl  = findEl(SELECTORS.responseText, targetEl) || targetEl;
    const markdown = htmlToMarkdown(textEl);
    const text     = (textEl.innerText || textEl.textContent || '').trim();
    return { markdown, text, isHtml: false };
  }

  async function tryNewChat() {
    const btn = findEl(SELECTORS.newChatBtn);
    if (btn) { btn.click(); await sleep(800); return true; }
    return false;
  }

  // ── HTML → Markdown ────────────────────────────────────
  function htmlToMarkdown(el) {

    // 判断是否是合法的编程语言名（用于从标签文本中识别语言）
    function isLangName(txt) {
      return txt && /^[a-z][a-z0-9#.+\-]*$/i.test(txt.trim()) && txt.trim().length <= 20;
    }

    // 从代码块容器中提取语言名
    function extractLang(wrapper) {
      const codeEl = wrapper.querySelector('code');
      const preEl  = wrapper.querySelector('pre');

      let lang = ((codeEl?.className || '').match(/language-(\S+)/) || [])[1] || '';
      if (lang) { return lang.toLowerCase(); }

      const allEls = Array.from(wrapper.querySelectorAll('*'));
      for (const child of allEls) {
        if (preEl && (preEl === child || preEl.contains(child))) { continue; }
        if (codeEl && (codeEl === child || codeEl.contains(child))) { continue; }
        const txt = (child.textContent || '').trim().toLowerCase();
        if (isLangName(txt)) { return txt; }
      }

      return '';
    }

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) { return node.textContent; }
      if (node.nodeType !== Node.ELEMENT_NODE) { return ''; }

      const tag = node.tagName.toLowerCase();
      const children = () => Array.from(node.childNodes).map(walk).join('');

      if (tag === 'code-block' || tag.endsWith('-code-block') || tag.includes('codeblock')) {
        const preEl  = node.querySelector('pre');
        const codeEl = node.querySelector('code');
        if (preEl || codeEl) {
          const lang = extractLang(node);
          const code = codeEl?.textContent || preEl?.textContent || '';
          return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n\n`;
        }
        return children();
      }

      switch (tag) {
        case 'h1': return `\n# ${children()}\n\n`;
        case 'h2': return `\n## ${children()}\n\n`;
        case 'h3': return `\n### ${children()}\n\n`;
        case 'h4': return `\n#### ${children()}\n\n`;
        case 'h5': return `\n##### ${children()}\n\n`;
        case 'h6': return `\n###### ${children()}\n\n`;
        case 'strong': case 'b':   return `**${children()}**`;
        case 'em':     case 'i':   return `*${children()}*`;
        case 'del':    case 's':   return `~~${children()}~~`;

        case 'code':
          if (node.parentElement?.tagName.toLowerCase() === 'pre') { return node.textContent || ''; }
          return `\`${node.textContent}\``;

        case 'pre': {
          const codeEl = node.querySelector('code');
          let lang = ((codeEl?.className || '').match(/language-(\S+)/) || [])[1] || '';

          if (!lang && node.previousElementSibling) {
            const prevEl = node.previousElementSibling;
            if (!prevEl.querySelector('pre, code, table, ul, ol')) {
              const txt = (prevEl.textContent || '').trim().toLowerCase();
              if (isLangName(txt)) { lang = txt; }
            }
          }

          if (!lang && node.parentElement) {
            const parent = node.parentElement;
            const headerSelectors = [
              '.code-block-title', '.code-title', '.language-label',
              '[class*="code-header"]', '[class*="lang"]'
            ];
            for (const sel of headerSelectors) {
              try {
                const labelEl = parent.querySelector(sel);
                if (labelEl && !node.contains(labelEl)) {
                  const txt = (labelEl.textContent || '').trim().toLowerCase();
                  if (isLangName(txt)) { lang = txt; break; }
                }
              } catch { /* skip */ }
            }
          }

          const code = codeEl ? codeEl.textContent : node.textContent;
          return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n\n`;
        }

        case 'p':          return `${children()}\n\n`;
        case 'br':         return '\n';
        case 'hr':         return '\n---\n\n';
        case 'ul':         return '\n' + Array.from(node.children).map(li => `- ${walk(li)}`).join('\n') + '\n\n';
        case 'ol':         return '\n' + Array.from(node.children).map((li, i) => `${i + 1}. ${walk(li)}`).join('\n') + '\n\n';
        case 'li':         return children().replace(/\n+$/, '');
        case 'blockquote': return `> ${children()}\n\n`;
        case 'a':          return `[${children()}](${node.href})`;
        case 'table': {
          const rows = Array.from(node.querySelectorAll('tr'));
          if (!rows.length) { return children(); }
          let md = '';
          rows.forEach((row, ri) => {
            const cells = Array.from(row.querySelectorAll('td, th'));
            md += '| ' + cells.map(c => c.textContent.trim()).join(' | ') + ' |\n';
            if (ri === 0) { md += '| ' + cells.map(() => '---').join(' | ') + ' |\n'; }
          });
          return '\n' + md + '\n';
        }
        case 'script': case 'style': case 'head': return '';
        default: return children();
      }
    }

    return walk(el).replace(/\n{3,}/g, '\n\n').trim();
  }

  // ── 监听 Background 消息 ─────────────────────────────────
  let isProcessing = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'ping':
        sendResponse({ pong: true, url: location.href });
        return false;

      case 'sendToGemini': {
        if (isProcessing) { sendResponse({ error: '上一个请求仍在处理中，请稍后再试' }); return false; }
        isProcessing = true;
        sendResponse({ ok: true, status: 'processing' });
        sendToGemini(msg.prompt)
          .then(data => { isProcessing = false; chrome.runtime.sendMessage({ type: 'aiResponse', data }); })
          .catch(err  => { isProcessing = false; console.error('[MirrorAi]', err); chrome.runtime.sendMessage({ type: 'aiError', message: err.message || '未知错误' }); });
        return false;
      }

      case 'newChat':
        tryNewChat().then(clicked => sendResponse({ clicked, ok: true }));
        return true;

      case 'updateSelectors':
        SELECTORS = Object.assign({}, SELECTORS, msg.selectors);
        sendResponse({ ok: true });
        return false;

      case 'getStatus':
        sendResponse({ ready: !!findEl(SELECTORS.input), processing: isProcessing });
        return false;
    }
    return false;
  });

  // ── 页面就绪通知 ──────────────────────────────────────────
  function notifyReady(ready) { chrome.runtime.sendMessage({ type: 'aiStatus', ready }).catch(() => {}); }
  new MutationObserver(() => notifyReady(!!findEl(SELECTORS.input))).observe(document.body, { childList: true, subtree: true });
  setTimeout(() => notifyReady(!!findEl(SELECTORS.input)), 2000);

  console.log('[MirrorAi] Content script 已加载');
})();
