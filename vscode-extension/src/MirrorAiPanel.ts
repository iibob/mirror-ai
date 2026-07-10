import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MirrorAiWebSocketServer } from './WebSocketServer';
import { insertCodeAtCursor, readFileContent } from './extension';

export interface FileContext {
  id: string; type: 'file';
  fsPath: string; fileName: string; language: string; content: string;
}
export interface SnippetContext {
  id: string; type: 'snippet';
  fsPath: string; fileName: string; language: string; content: string;
  startLine: number; endLine: number;
}
export type Context = FileContext | SnippetContext;

export class MirrorAiPanel {
  public static currentPanel: MirrorAiPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly wsServer: MirrorAiWebSocketServer;
  private readonly disposables: vscode.Disposable[] = [];
  private contexts: Map<string, Context> = new Map();
  private lastEditor: vscode.TextEditor | undefined;

  // ── 静态工厂 ────────────────────────────────────────────
  public static createOrShow(
    context: vscode.ExtensionContext,
    wsServer: MirrorAiWebSocketServer
  ): void {
    if (MirrorAiPanel.currentPanel) {
      MirrorAiPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'mirrorAi', 'Mirror Ai', vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    MirrorAiPanel.currentPanel = new MirrorAiPanel(panel, context, wsServer);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    wsServer: MirrorAiWebSocketServer
  ) {
    this.panel = panel;
    this.context = context;
    this.wsServer = wsServer;
    this.lastEditor = vscode.window.activeTextEditor;

    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        this.lastEditor = editor;
      }
    }, null, this.disposables);

    this.panel.webview.html = this.buildHtml();
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon16.png');

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg), null, this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  // ── 用于 extension.ts 命令中同步最新编辑器 ──────────────
  public setLastEditor(editor: vscode.TextEditor): void {
    this.lastEditor = editor;
  }

  // ── Webview 消息处理 ────────────────────────────────────
  private async handleWebviewMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {

      case 'ready':
        this.postMessage({ type: 'initState', isConnected: this.wsServer.clientCount > 0 });
        break;

      case 'sendQuestion':
        this.dispatchQuestion(msg.question as string, (msg.contextIds as string[]) ?? []);
        break;

      case 'newChat':
        this.wsServer.broadcast({ type: 'newChat' });
        break;

      case 'cancelRequest':
        this.wsServer.broadcast({ type: 'cancel' });
        break;

      case 'insertCode':
        await insertCodeAtCursor(msg.code as string, msg.language as string);
        break;

      case 'addCurrentFile': {
        const editor = this.lastEditor ?? vscode.window.activeTextEditor;
        if (editor) {
          this.addFileFromEditor(editor);
        } else {
          vscode.window.showWarningMessage('Mirror Ai：没有找到活跃的编辑器，请先在代码文件中点击一下，再点此按钮');
        }
        break;
      }

      case 'addSelection': {
        const editor = this.lastEditor ?? vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Mirror Ai：没有找到活跃的编辑器，请先在代码文件中选中代码，再点此按钮');
        } else if (editor.selection.isEmpty) {
          vscode.window.showWarningMessage('Mirror Ai：当前编辑器没有选中任何代码，请先选中后再点此按钮');
        } else {
          this.addSelectionFromEditor(editor);
        }
        break;
      }

      case 'pickFile':
        await this.pickFiles();
        break;

      case 'removeContext':
        this.contexts.delete(msg.id as string);
        break;

      case 'openFile': {
        const fsPath = msg.fsPath as string;
        if (fsPath && fs.existsSync(fsPath)) {
          const doc = await vscode.workspace.openTextDocument(fsPath);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }
        break;
      }
    }
  }

  // ── 添加文件 / 片段 ─────────────────────────────────────
  public addFileFromEditor(editor: vscode.TextEditor): void {
    const fsPath = editor.document.uri.fsPath;
    const id = `file:${fsPath}`;
    if (this.contexts.has(id)) { this.postMessage({ type: 'contextAlreadyAdded', id }); return; }

    const ctx: FileContext = {
      id, type: 'file', fsPath,
      fileName: path.basename(fsPath),
      language: editor.document.languageId,
      content: editor.document.getText()
    };
    this.contexts.set(id, ctx);
    this.postMessage({
      type: 'contextAdded',
      context: { id, type: 'file', fileName: ctx.fileName, language: ctx.language, lineCount: editor.document.lineCount }
    });
  }

  public addSelectionFromEditor(editor: vscode.TextEditor): void {
    const fsPath = editor.document.uri.fsPath;
    const sel = editor.selection;
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    const id = `snippet:${fsPath}:${startLine}:${endLine}:${Date.now()}`;

    const ctx: SnippetContext = {
      id, type: 'snippet', fsPath,
      fileName: path.basename(fsPath),
      language: editor.document.languageId,
      content: editor.document.getText(sel),
      startLine, endLine
    };
    this.contexts.set(id, ctx);
    this.postMessage({
      type: 'contextAdded',
      context: { id, type: 'snippet', fileName: ctx.fileName, language: ctx.language, startLine, endLine }
    });
  }

  private async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: '添加到 Mirror Ai',
      filters: { '代码文件': ['ts', 'js', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'cs', 'php', 'rb', 'swift', 'kt'], '所有文件': ['*'] }
    });
    if (!uris) { return; }
    for (const uri of uris) {
      const fsPath = uri.fsPath;
      const id = `file:${fsPath}`;
      if (this.contexts.has(id)) { continue; }
      const content = readFileContent(fsPath);
      if (content === null) { vscode.window.showErrorMessage(`无法读取文件: ${fsPath}`); continue; }
      const doc = await vscode.workspace.openTextDocument(uri);
      const ctx: FileContext = {
        id, type: 'file', fsPath,
        fileName: path.basename(fsPath),
        language: doc.languageId, content
      };
      this.contexts.set(id, ctx);
      this.postMessage({
        type: 'contextAdded',
        context: { id, type: 'file', fileName: ctx.fileName, language: ctx.language, lineCount: doc.lineCount }
      });
    }
  }

  // ── 发送问题 ─────────────────────────────────────────────
  private dispatchQuestion(userQuestion: string, contextIds: string[]): void {
    if (this.wsServer.clientCount === 0) {
      this.postMessage({ type: 'sendError', message: 'Chrome 插件未连接，请先打开 Chrome 插件' });
      return;
    }

    const parts: string[] = [];
    const ctxSummary: Array<{ type: string; fileName: string; startLine?: number; endLine?: number }> = [];

    const addedCtxs = contextIds
      .map(id => this.contexts.get(id))
      .filter((c): c is Context => c !== undefined);

    if (addedCtxs.length > 0) {
      parts.push('以下是相关代码：\n');
      for (const ctx of addedCtxs) {
        if (ctx.type === 'file') {
          parts.push(`文件: ${ctx.fileName}\n${ctx.content}\n`);
          ctxSummary.push({ type: 'file', fileName: ctx.fileName });
        } else {
          parts.push(`代码片段: ${ctx.fileName} 第 ${ctx.startLine}-${ctx.endLine} 行\n${ctx.content}\n`);
          ctxSummary.push({ type: 'snippet', fileName: ctx.fileName, startLine: ctx.startLine, endLine: ctx.endLine });
        }
      }
    }

    if (userQuestion.trim()) {
      parts.push(userQuestion.trim());
    }

    const fullPrompt = parts.join('\n');
    this.wsServer.broadcast({ type: 'question', data: { prompt: fullPrompt } });
    this.postMessage({ type: 'questionSent', question: userQuestion, contexts: ctxSummary, fullPrompt });
  }

  // ── 通用方法 ─────────────────────────────────────────────
  public postMessage(msg: Record<string, unknown>): void {
    this.panel.webview.postMessage(msg);
  }

  public reload(): void {
    this.panel.webview.html = '';
    this.panel.webview.html = this.buildHtml();
  }

  // ── HTML ─────────────────────────────────────────────────
  private buildHtml(): string {
    const webview = this.panel.webview;
    const nonce = this.getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css'));
    const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Mirror Ai</title>
</head>
<body>
  <div id="app">
    <div id="status-bar">
      <div id="conn-status" class="status-dot disconnected" title="Chrome 插件连接状态">
        <span class="dot"></span><span class="label">Chrome 未连接</span>
      </div>
      <div id="ai-status" class="status-dot disconnected" title="Gemini 页面状态">
        <span class="dot"></span><span class="label">Gemini 未就绪</span>
      </div>
      <div class="spacer"></div>
      <button id="btn-new-chat" class="icon-btn" title="新建对话（同时在 Gemini 中新建）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        新建对话
      </button>
    </div>

    <div id="chat-area-wrapper">
      <div id="chat-area">
        <div id="chat-list">
          <div id="empty-state">
            <p class="empty-title">Mirror Ai</p>
            <p class="empty-hint">选择代码或文件，输入问题，发送给 Gemini</p>
          </div>
        </div>
      </div>
      <div id="chat-scrollbar-track">
        <div id="chat-scrollbar-thumb"></div>
      </div>
    </div>

    <div id="input-area">
      <div id="context-strip" class="hidden">
        <div id="context-tags"></div>
      </div>
      <div id="file-bar">
        <button class="file-btn" id="btn-add-current" title="添加当前编辑器文件">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
          </svg>当前文件
        </button>
        <button class="file-btn" id="btn-add-other" title="从磁盘选择文件">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
          </svg>其他文件
        </button>
        <button class="file-btn" id="btn-add-selection" title="添加编辑器中选中的代码">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 7 4 4 20 4 20 7"/>
            <line x1="9" y1="20" x2="15" y2="20"/>
            <line x1="12" y1="4" x2="12" y2="20"/>
          </svg>选中片段
        </button>
      </div>
      <div id="textarea-wrap">
        <textarea id="question-input" placeholder="输入问题 ..." rows="3" spellcheck="false"></textarea>
      </div>
      <div id="presets">
        <span class="preset-label">快捷：</span>
        <button class="preset-btn" data-text="简单回复，不要太长">简单回复</button>
        <button class="preset-btn" data-text="只给需要修改的代码，如：在A下方添加B、把C替换成D、删除E">修改代码</button>
        <button class="preset-btn" data-text="只回复代码，不需要解释">只回代码</button>
        <button class="preset-btn" data-text="详细解释这段代码的逻辑">详细解释</button>
        <button class="preset-btn" data-text="给每行代码加注释">加注释</button>
        <button class="preset-btn" data-text="找出这段代码中的bug并给出修复方案">查找 Bug</button>
      </div>
      <div id="bottom-bar">
        <button id="btn-clear" class="btn-secondary">清空输入</button>
        <div class="spacer"></div>
        <button id="btn-send" class="btn-primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>发送
        </button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${mainJsUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  dispose(): void {
    MirrorAiPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
