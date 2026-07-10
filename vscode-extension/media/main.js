// Webview 前端界面

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const state = {
    contexts: [],
    aiReady: false,
    isConnected: false,
    sending: false
  };

  let responseTimer = null;
  let warningTimer  = null;
  const WARN_TIMEOUT_MS     = 60 * 1000;       // 1 分钟提醒
  const RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;   // 3 分钟超时

  // ── DOM ──────────────────────────────────────────────────
  const $           = id => document.getElementById(id);
  const chatList    = $('chat-list');
  const emptyState  = $('empty-state');
  const chatArea    = $('chat-area');
  const scrollTrack = $('chat-scrollbar-track');
  const scrollThumb = $('chat-scrollbar-thumb');
  const qInput      = $('question-input');
  const ctxStrip    = $('context-strip');
  const ctxTagsEl   = $('context-tags');
  const connDot     = $('conn-status');
  const aiDot       = $('ai-status');
  const btnSend     = $('btn-send');
  const btnClear    = $('btn-clear');
  const btnNewChat  = $('btn-new-chat');

  // ── 接收扩展消息 ─────────────────────────────────────────
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'initState':           setConnected(msg.isConnected); break;
      case 'chromeConnected':     setConnected(true); break;
      case 'chromeDisconnected':
        setConnected(msg.count > 0);
        if (state.sending && msg.count === 0) abortSending('Chrome 插件连接断开，请重新连接后再试');
        break;
      case 'statusUpdate':        handleStatusUpdate(msg.data); break;
      case 'contextAdded':        addContextTag(msg.context); break;
      case 'contextAlreadyAdded': flashTag(msg.id); break;
      case 'questionSent':        handleQuestionSent(msg); break;
      case 'aiResponse':          handleAIResponse(msg.data); break;
      case 'sendError':           abortSending(msg.message); break;
      case 'remoteError':         abortSending((msg.data && msg.data.message) || '远程错误，请检查 Gemini 页面'); break;
    }
  });

  // ── 连接状态 ─────────────────────────────────────────────
  function setConnected(on) {
    state.isConnected = on;
    connDot.className = 'status-dot ' + (on ? 'connected' : 'disconnected');
    connDot.querySelector('.label').textContent = on ? 'Chrome 已连接' : 'Chrome 未连接';
    if (!btnSend._isStopMode) {
      btnSend.disabled = !on || state.sending;
    }
  }

  function handleStatusUpdate(data) {
    if (!data) return;
    if (typeof data.aiReady === 'boolean') {
      state.aiReady = data.aiReady;
      aiDot.className = 'status-dot ' + (data.aiReady ? 'connected' : 'disconnected');
      aiDot.querySelector('.label').textContent = data.aiReady ? 'Gemini 就绪' : 'Gemini 未就绪';
    }
    if (typeof data.chromeConnected === 'boolean') setConnected(data.chromeConnected);
  }

  // ── 上下文标签 ───────────────────────────────────────────
  function addContextTag(ctx) {
    if (state.contexts.find(c => c.id === ctx.id)) { flashTag(ctx.id); return; }
    state.contexts.push(ctx);

    const tag = document.createElement('div');
    tag.className = 'ctx-tag';
    tag._ctxId = ctx.id;

    const label = ctx.type === 'snippet'
      ? `${ctx.fileName}:${ctx.startLine}-${ctx.endLine}` : ctx.fileName;

    const mkSpan = (cls, text, title) => {
      const s = document.createElement('span');
      s.className = cls; s.textContent = text;
      if (title) s.title = title;
      return s;
    };

    const rmBtn = document.createElement('button');
    rmBtn.className = 'ctx-remove'; rmBtn.title = '移除'; rmBtn.textContent = '✕';
    rmBtn.addEventListener('click', e => {
      e.stopPropagation();
      tag.remove();
      state.contexts = state.contexts.filter(c => c.id !== ctx.id);
      if (state.contexts.length === 0) ctxStrip.classList.add('hidden');
      vscode.postMessage({ type: 'removeContext', id: ctx.id });
    });

    tag.appendChild(mkSpan('ctx-icon', ctx.type === 'file' ? '📄' : '✂️'));
    tag.appendChild(mkSpan('ctx-label', label, label));
    tag.appendChild(mkSpan('ctx-lang', ctx.language));
    tag.appendChild(rmBtn);

    ctxTagsEl.appendChild(tag);
    ctxStrip.classList.remove('hidden');
  }

  function flashTag(id) {
    for (const child of ctxTagsEl.children) {
      if (child._ctxId === id) {
        child.classList.add('flash');
        setTimeout(() => child.classList.remove('flash'), 600);
        return;
      }
    }
  }

  // ── 文件操作按钮 ─────────────────────────────────────────
  $('btn-add-current').addEventListener('click',   () => vscode.postMessage({ type: 'addCurrentFile' }));
  $('btn-add-other').addEventListener('click',     () => vscode.postMessage({ type: 'pickFile' }));
  $('btn-add-selection').addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));

  // ── 预设消息 ─────────────────────────────────────────────
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cur = qInput.value.trim();
      qInput.value = cur ? cur + '\n' + btn.dataset.text : btn.dataset.text;
      qInput.focus();
      autoResize();
    });
  });

  // ── 输入框 ───────────────────────────────────────────────
  function autoResize() {
    qInput.style.height = 'auto';
    qInput.style.height = Math.min(qInput.scrollHeight, 200) + 'px';
  }
  qInput.addEventListener('input', autoResize);
  qInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      if (e.shiftKey || e.isComposing) return;
      e.preventDefault();
      sendQuestion();
    }
  });

  btnClear.addEventListener('click', () => { qInput.value = ''; autoResize(); qInput.focus(); });

  // ── 新建对话 ─────────────────────────────────────────────
  btnNewChat.addEventListener('click', () => {
    while (chatList.firstChild) chatList.removeChild(chatList.firstChild);
    chatList.appendChild(emptyState);
    emptyState.style.display = '';

    ctxTagsEl.innerHTML = '';
    ctxStrip.classList.add('hidden');
    state.contexts = [];

    qInput.value = '';
    autoResize();
    clearAllTimers();
    if (state.sending) { state.sending = false; setSendingState(false); }

    vscode.postMessage({ type: 'newChat' });
    qInput.focus();
  });

  // ── 发送按钮 ───────────────────────────────────────────────
  btnSend.addEventListener('click', () => {
    if (btnSend._isStopMode) {
      vscode.postMessage({ type: 'cancelRequest' });
      abortSending('已手动停止等待回复，可重新发送问题');
    } else {
      sendQuestion();
    }
  });

  function sendQuestion() {
    if (state.sending) return;
    const question   = qInput.value.trim();
    const contextIds = state.contexts.map(c => c.id);
    if (!question && contextIds.length === 0) { qInput.focus(); return; }
    if (!state.isConnected) { appendErrorBubble('Chrome 插件未连接，请先安装并打开 Chrome 插件'); return; }
    vscode.postMessage({ type: 'sendQuestion', question, contextIds });
  }

  // ── 消息已发出 ───────────────────────────────────────────
  function handleQuestionSent(msg) {
    state.sending = true;
    setSendingState(true);
    hideEmpty();
    qInput.value = '';
    autoResize();

    appendUserBubble(msg.question, msg.contexts || [], msg.fullPrompt || '');

    ctxTagsEl.innerHTML = '';
    ctxStrip.classList.add('hidden');
    state.contexts = [];

    appendLoadingBubble();
    startResponseTimer();
    setWaitingState();
  }

  // ── 回复 ─────────────────────────────────────────────────
  function handleAIResponse(data) {
    if (!state.sending) return;
    clearAllTimers();
    state.sending = false;
    setSendingState(false);
    removeLoadingBubble();
    if (!data) return;
    if (data.error) {
      appendErrorBubble(data.errorMessage || '未知错误');
    } else {
      appendAssistantBubble(data.markdown || data.text || data.html || '', !!data.isHtml);
    }
    scrollToBottom();
  }

  // ── 中止发送 ─────────────────────────────────────────────
  function abortSending(msg) {
    clearAllTimers();
    state.sending = false;
    setSendingState(false);
    removeLoadingBubble();
    appendErrorBubble(msg);
  }

  // ── 计时器 ───────────────────────────────────────────────
  function startResponseTimer() {
    clearAllTimers();

    // 1 分钟：提醒检查浏览器状态
    warningTimer = setTimeout(() => {
      if (state.sending) {
        appendWarnBubble('已等待 1 分钟未收到回复，请确认浏览器没有最小化');
      }
    }, WARN_TIMEOUT_MS);

    // 3 分钟：超时终止
    responseTimer = setTimeout(() => {
      if (state.sending) {
        abortSending('等待回复超时（3 分钟），请检查 Gemini 页面状态后重新发送');
      }
    }, RESPONSE_TIMEOUT_MS);
  }

  function clearAllTimers() {
    if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
    if (warningTimer)  { clearTimeout(warningTimer);  warningTimer  = null; }
  }

  // ── 按钮状态 ─────────────────────────────────────────────

  // 发送中（短暂过渡状态）
  function setSendingState(sending) {
    btnSend._isStopMode = false;
    btnSend.classList.remove('stop-mode', 'loading');
    btnSend.disabled = sending || !state.isConnected;
    if (sending) {
      btnSend.classList.add('loading');
      btnSend.innerHTML = '<span class="spin">⟳</span> 发送中…';
    } else {
      btnSend.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="22" y1="2" x2="11" y2="13"/>
        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg> 发送`;
    }
  }

  // 等待回复中（可点击停止）
  function setWaitingState() {
    btnSend._isStopMode = true;
    btnSend.disabled = false;
    btnSend.classList.remove('loading');
    btnSend.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
    </svg> 停止等待`;
  }

  // ── 气泡 ─────────────────────────────────────────────────

  function appendUserBubble(question, contexts, fullPrompt) {
    const row = document.createElement('div');
    row.className = 'chat-row user-row';

    let ctxHtml = '';
    if (contexts.length > 0) {
      ctxHtml = '<div class="bubble-ctx">' +
        contexts.map(c => {
          const label = c.type === 'snippet' ? `${c.fileName}:${c.startLine}-${c.endLine}` : c.fileName;
          return `<span class="ctx-chip">${c.type === 'file' ? '📄' : '✂️'} ${escHtml(label)}</span>`;
        }).join('') + '</div>';
    }

    row.innerHTML = `
      <div class="bubble user-bubble">
        ${ctxHtml}
        ${question ? `<div class="bubble-text">${escHtml(question)}</div>` : ''}
        <div class="bubble-footer">
          <button class="user-copy-btn">复制</button>
          <span class="bubble-time">${now()}</span>
        </div>
      </div>`;

    chatList.appendChild(row);

    const userCopyBtn = row.querySelector('.user-copy-btn');
    if (userCopyBtn) {
      const textToCopy = fullPrompt || question;
      userCopyBtn.addEventListener('click', function () {
        copyText(textToCopy);
        this.textContent = '已复制';
        setTimeout(() => { this.textContent = '复制'; }, 2000);
      });
    }

    // 长消息折叠：超过 3 行时自动折叠，支持展开/折叠
    if (question) {
      const textEl = row.querySelector('.bubble-text');
      if (textEl) {
        textEl.classList.add('bubble-text-collapsible');
        requestAnimationFrame(() => {
          if (textEl.scrollHeight > textEl.clientHeight + 4) {
            // 内容超出 3 行，添加展开/折叠按钮
            const toggleBtn = document.createElement('button');
            toggleBtn.className   = 'bubble-toggle';
            toggleBtn.textContent = '展开 ▶';
            let expanded = false;
            toggleBtn.addEventListener('click', () => {
              expanded = !expanded;
              textEl.classList.toggle('bubble-text-expanded', expanded);
              toggleBtn.textContent = expanded ? '折叠 ▼' : '展开 ▶';
              updateScrollbar();
            });
            row.querySelector('.user-bubble').insertBefore(toggleBtn, row.querySelector('.bubble-footer'));
          } else {
            // 内容本身就在 3 行内，取消折叠限制
            textEl.classList.remove('bubble-text-collapsible');
          }
        });
      }
    }

    scrollToBottom();
  }

  function appendLoadingBubble() {
    const row = document.createElement('div');
    row.className = 'chat-row assistant-row loading-row';
    row.innerHTML = `
      <div class="bubble assistant-bubble">
        <div class="bubble-header"><span class="ai-badge">✦ Gemini</span></div>
        <div class="bubble-loading"><span></span><span></span><span></span></div>
      </div>`;
    chatList.appendChild(row);
    scrollToBottom();
  }

  function removeLoadingBubble() { chatList.querySelector('.loading-row')?.remove(); }

  function appendAssistantBubble(content, isHtml) {
    const row = document.createElement('div');
    row.className = 'chat-row assistant-row';

    const rendered = isHtml ? sanitizeHtml(content) : renderMarkdown(content);
    row.innerHTML = `
      <div class="bubble assistant-bubble">
        <div class="bubble-header">
          <span class="ai-badge">✦ Gemini</span>
          <button class="copy-all-btn" title="复制全文">复制全文</button>
        </div>
        <div class="bubble-content markdown-body">${rendered}</div>
        <div class="bubble-time">${now()}</div>
      </div>`;

    const bubbleContent = row.querySelector('.bubble-content');
    bubbleContent.dataset.markdown = content;

    row.querySelectorAll('pre').forEach(pre => {
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;
      const lang = (codeEl.className.match(/language-(\S+)/) || [])[1] || '';

      const wrap = document.createElement('div');
      wrap.className = 'code-wrap';

      const hdr = document.createElement('div');
      hdr.className = 'code-header';

      const langSpan = document.createElement('span');
      langSpan.className   = 'code-lang';
      langSpan.textContent = lang || 'text';

      const acts = document.createElement('div');
      acts.className = 'code-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className   = 'code-btn copy-btn';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', () => {
        copyText(codeEl.innerText);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
      });

      const insBtn = document.createElement('button');
      insBtn.className   = 'code-btn insert-btn';
      insBtn.textContent = '插入到编辑器';
      insBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'insertCode', code: codeEl.innerText, language: lang || 'text' });
      });

      acts.appendChild(copyBtn);
      acts.appendChild(insBtn);
      hdr.appendChild(langSpan);
      hdr.appendChild(acts);
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(hdr);
      wrap.appendChild(pre);
    });

    row.querySelector('.copy-all-btn').addEventListener('click', function () {
      copyText(bubbleContent.dataset.markdown || bubbleContent.innerText);
      this.textContent = '已复制';
      setTimeout(() => { this.textContent = '复制全文'; }, 2000);
    });

    chatList.appendChild(row);
    scrollToBottom();
  }

  function appendErrorBubble(message) {
    hideEmpty();
    const row = document.createElement('div');
    row.className = 'chat-row error-row';
    row.innerHTML = `<div class="bubble error-bubble">⚠ ${escHtml(message)}</div>`;
    chatList.appendChild(row);
    scrollToBottom();
  }

  // 警告气泡（黄色，用于超时提醒等非致命提示）
  function appendWarnBubble(message) {
    hideEmpty();
    const row = document.createElement('div');
    row.className = 'chat-row warn-row';
    row.innerHTML = `<div class="bubble warn-bubble">⏱ ${escHtml(message)}</div>`;
    chatList.appendChild(row);
    scrollToBottom();
  }

  // ── 辅助 ─────────────────────────────────────────────────
  function hideEmpty()      { emptyState.style.display = 'none'; }
  function scrollToBottom() { chatArea.scrollTop = chatArea.scrollHeight; updateScrollbar(); }
  function now()            { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  function escHtml(s)       { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function copyText(t)      { navigator.clipboard?.writeText(t).catch(() => fbCopy(t)) || fbCopy(t); }
  function fbCopy(t)        {
    const a = Object.assign(document.createElement('textarea'), { value: t });
    Object.assign(a.style, { position: 'fixed', opacity: '0' });
    document.body.appendChild(a); a.select(); document.execCommand('copy'); document.body.removeChild(a);
  }

  // ── 自定义滚动条 ──────────────────────────────────────────
  function updateScrollbar() {
    if (!scrollTrack || !scrollThumb) return;
    const trackH    = scrollTrack.clientHeight;
    const contentH  = chatArea.scrollHeight;
    const visibleH  = chatArea.clientHeight;

    if (contentH <= visibleH) {
      scrollThumb.style.height = '0px';
      return;
    }

    const thumbH     = Math.max((visibleH / contentH) * trackH, 28);
    const maxTop     = trackH - thumbH;
    const ratio      = chatArea.scrollTop / (contentH - visibleH);
    scrollThumb.style.height = thumbH + 'px';
    scrollThumb.style.top    = (ratio * maxTop) + 'px';
  }

  chatArea.addEventListener('scroll', updateScrollbar);
  window.addEventListener('resize', updateScrollbar);

  // 拖动滑块
  let isDragging       = false;
  let dragStartY       = 0;
  let dragStartScrollT = 0;

  scrollThumb.addEventListener('mousedown', e => {
    isDragging       = true;
    dragStartY       = e.clientY;
    dragStartScrollT = chatArea.scrollTop;
    scrollThumb.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const trackH    = scrollTrack.clientHeight;
    const thumbH    = scrollThumb.clientHeight;
    const maxTop    = trackH - thumbH;
    const scrollableH = chatArea.scrollHeight - chatArea.clientHeight;
    const delta     = e.clientY - dragStartY;
    chatArea.scrollTop = dragStartScrollT + (delta / maxTop) * scrollableH;
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    scrollThumb.classList.remove('dragging');
    document.body.style.userSelect = '';
  });

  // 点击轨道跳转
  scrollTrack.addEventListener('mousedown', e => {
    if (e.target === scrollThumb) return;
    const rect      = scrollTrack.getBoundingClientRect();
    const clickY    = e.clientY - rect.top;
    const thumbH    = scrollThumb.clientHeight;
    const maxTop    = scrollTrack.clientHeight - thumbH;
    const targetTop = Math.min(Math.max(clickY - thumbH / 2, 0), maxTop);
    const scrollableH = chatArea.scrollHeight - chatArea.clientHeight;
    chatArea.scrollTop = (targetTop / maxTop) * scrollableH;
  });

  // ── Markdown 渲染器 ───────────────────────────────────────
  function renderMarkdown(md) {
    if (!md) return '';

    const fences = [];
    md = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = fences.length; fences.push({ lang: lang || '', code }); return `\x00F${i}\x00`;
    });

    const codes = [];
    md = md.replace(/`([^`\n]+)`/g, (_, c) => { const i = codes.length; codes.push(c); return `\x00C${i}\x00`; });

    md = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    md = md.replace(/^#{6}\s(.+)$/gm,'<h6>$1</h6>').replace(/^#{5}\s(.+)$/gm,'<h5>$1</h5>')
           .replace(/^#{4}\s(.+)$/gm,'<h4>$1</h4>').replace(/^###\s(.+)$/gm,'<h3>$1</h3>')
           .replace(/^##\s(.+)$/gm,'<h2>$1</h2>').replace(/^#\s(.+)$/gm,'<h1>$1</h1>');

    md = md.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>')
           .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>')
           .replace(/___(.+?)___/g,'<strong><em>$1</em></strong>')
           .replace(/__(.+?)__/g,'<strong>$1</strong>').replace(/_(.+?)_/g,'<em>$1</em>')
           .replace(/~~(.+?)~~/g,'<del>$1</del>');

    md = md.replace(/^\s*([-*_]){3,}\s*$/gm,'<hr>');

    md = md.replace(/^(\s*)[-*+]\s(.+)$/gm,(_,i,t)=>`\x00L${Math.floor((i||'').length/2)} ${t}\x00`)
           .replace(/^(\s*)\d+\.\s(.+)$/gm,(_,i,t)=>`\x00O${Math.floor((i||'').length/2)} ${t}\x00`);
    md = md.replace(/(\x00L\d+ .+\x00\n?)+/g,b=>'<ul>'+(b.match(/\x00L\d+ (.+)\x00/g)||[])
           .map(x=>`<li>${x.replace(/\x00L\d+ /,'').replace(/\x00$/,'')}</li>`).join('')+'</ul>');
    md = md.replace(/(\x00O\d+ .+\x00\n?)+/g,b=>'<ol>'+(b.match(/\x00O\d+ (.+)\x00/g)||[])
           .map(x=>`<li>${x.replace(/\x00O\d+ /,'').replace(/\x00$/,'')}</li>`).join('')+'</ol>');

    md = md.replace(/^&gt;\s(.+)$/gm,'<blockquote>$1</blockquote>');

    md = md.split(/\n{2,}/).map(b=>{
      b=b.trim(); if(!b)return'';
      if(/^<(h[1-6]|ul|ol|blockquote|hr|pre|div)/.test(b))return b;
      return '<p>'+b.replace(/\n/g,'<br>')+'</p>';
    }).join('\n');

    md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    codes.forEach((c,i)=>{ md=md.replace(`\x00C${i}\x00`,`<code>${escHtml(c)}</code>`); });

    fences.forEach(({lang,code},i)=>{
      const safe=code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      md=md.replace(`\x00F${i}\x00`,`<pre><code class="language-${escHtml(lang||'text')}">${safe}</code></pre>`);
    });

    return md;
  }

  function sanitizeHtml(html) {
    const ok=new Set(['p','br','b','strong','i','em','u','s','del','h1','h2','h3','h4','h5','h6',
      'ul','ol','li','blockquote','hr','pre','code','a','span','div','table','thead','tbody','tr','th','td']);
    const d=document.createElement('div'); d.innerHTML=html;
    d.querySelectorAll('*').forEach(el=>{
      if(!ok.has(el.tagName.toLowerCase())){el.replaceWith(...el.childNodes);return;}
      Array.from(el.attributes).forEach(a=>{if(!['class','href','title','target','rel'].includes(a.name))el.removeAttribute(a.name);});
      if(el.tagName==='A'){el.setAttribute('target','_blank');el.setAttribute('rel','noopener noreferrer');}
    });
    return d.innerHTML;
  }

  updateScrollbar();
  vscode.postMessage({ type: 'ready' });

})();
