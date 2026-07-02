import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MirrorAiWebSocketServer } from './WebSocketServer';
import { MirrorAiPanel } from './MirrorAiPanel';

let wsServer: MirrorAiWebSocketServer | undefined;
let lastActiveEditor: vscode.TextEditor | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('[MirrorAi] 插件已激活');

  // ── 启动 WebSocket 服务 ──────────────────────────────────
  wsServer = new MirrorAiWebSocketServer(8765);
  wsServer.start();

  wsServer.on('clientConnected', (count: number) => {
    MirrorAiPanel.currentPanel?.postMessage({ type: 'chromeConnected', count });
    vscode.window.setStatusBarMessage(`$(check) Mirror Ai: Chrome 已连接 (${count})`, 3000);
  });

  wsServer.on('clientDisconnected', (count: number) => {
    MirrorAiPanel.currentPanel?.postMessage({ type: 'chromeDisconnected', count });
    if (count === 0) {
      vscode.window.setStatusBarMessage('$(x) Mirror Ai: Chrome 未连接', 5000);
    }
  });

  wsServer.on('aiResponse', (data: unknown) => {
    MirrorAiPanel.currentPanel?.postMessage({ type: 'aiResponse', data });
  });

  wsServer.on('statusUpdate', (data: unknown) => {
    MirrorAiPanel.currentPanel?.postMessage({ type: 'statusUpdate', data });
  });

  wsServer.on('remoteError', (data: unknown) => {
    MirrorAiPanel.currentPanel?.postMessage({ type: 'remoteError', data });
    const msg = (data as { message?: string })?.message || '未知错误';
    vscode.window.showErrorMessage(`Mirror Ai: ${msg}`);
  });

  wsServer.on('error', (msg: string) => {
    vscode.window.showErrorMessage(`Mirror Ai 启动失败: ${msg}`);
  });

  // ── 跟踪活跃编辑器 ──────────────────────────────────────
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      lastActiveEditor = editor;
      // 通知面板当前编辑器信息
      MirrorAiPanel.currentPanel?.postMessage({
        type: 'editorChanged',
        fileName: path.basename(editor.document.uri.fsPath),
        language: editor.document.languageId,
        fsPath: editor.document.uri.fsPath
      });
    }
  }, null, context.subscriptions);

  // ── 注册命令 ─────────────────────────────────────────────
  context.subscriptions.push(

    // 打开面板
    vscode.commands.registerCommand('mirrorAi.openPanel', () => {
      MirrorAiPanel.createOrShow(context, wsServer!);
    }),

    // 添加当前文件
    vscode.commands.registerCommand('mirrorAi.addCurrentFile', () => {
      const editor = lastActiveEditor ?? vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('没有找到活跃的编辑器');
        return;
      }
      MirrorAiPanel.createOrShow(context, wsServer!);
      MirrorAiPanel.currentPanel?.addFileFromEditor(editor);
    }),

    // 添加选中代码
    vscode.commands.registerCommand('mirrorAi.addSelection', () => {
      const editor = lastActiveEditor ?? vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('请先在编辑器中选中代码');
        return;
      }
      MirrorAiPanel.createOrShow(context, wsServer!);
      MirrorAiPanel.currentPanel?.addSelectionFromEditor(editor);
    })
  );

  // ── 监听 media 文件变化，自动刷新 Webview（开发辅助）──
  const mediaWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.extensionUri, 'media/**')
  );
  mediaWatcher.onDidChange(() => {
    MirrorAiPanel.currentPanel?.reload();
  });
  context.subscriptions.push(mediaWatcher);

  // 初始化 lastActiveEditor
  lastActiveEditor = vscode.window.activeTextEditor;
}

export function deactivate(): void {
  wsServer?.stop();
}

// ── 供 MirrorAiPanel 调用的辅助函数 ─────────────────────────

/** 在当前光标处插入代码 */
export async function insertCodeAtCursor(code: string, language: string): Promise<void> {
  const editor = lastActiveEditor ?? vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('没有找到活跃的编辑器，无法插入代码');
    return;
  }

  const docLang = editor.document.languageId;
  const { lineStart, lineEnd } = getCommentStyle(docLang);
  const newline = '\n';

  const lines = [
    lineStart + ' ── 开始插入 ──' + lineEnd,
    code,
    lineStart + ' ── 插入结束 ──' + lineEnd,
    ''  // 末尾空行
  ];

  const insertText = lines.join(newline);

  await editor.edit(builder => {
    // 在光标处插入，保持换行
    const pos = editor.selection.active;
    const lineText = editor.document.lineAt(pos.line).text;
    const prefix = lineText.trim() === '' ? '' : newline;
    builder.insert(pos, prefix + insertText);
  });

  // 滚动到插入位置
  const newPos = editor.selection.active;
  editor.revealRange(new vscode.Range(newPos, newPos));
}

/** 根据语言返回单行注释风格 */
function getCommentStyle(lang: string): { lineStart: string; lineEnd: string } {
  const styles: Record<string, { lineStart: string; lineEnd: string }> = {
    python:     { lineStart: '#',   lineEnd: '' },
    ruby:       { lineStart: '#',   lineEnd: '' },
    shellscript:{ lineStart: '#',   lineEnd: '' },
    shell:      { lineStart: '#',   lineEnd: '' },
    bash:       { lineStart: '#',   lineEnd: '' },
    powershell: { lineStart: '#',   lineEnd: '' },
    yaml:       { lineStart: '#',   lineEnd: '' },
    dockerfile: { lineStart: '#',   lineEnd: '' },
    perl:       { lineStart: '#',   lineEnd: '' },
    r:          { lineStart: '#',   lineEnd: '' },
    html:       { lineStart: '<!--',lineEnd: '-->' },
    xml:        { lineStart: '<!--',lineEnd: '-->' },
    markdown:   { lineStart: '<!--',lineEnd: '-->' },
    css:        { lineStart: '/*',  lineEnd: ' */' },
    scss:       { lineStart: '/*',  lineEnd: ' */' },
    less:       { lineStart: '/*',  lineEnd: ' */' },
    lua:        { lineStart: '--',  lineEnd: '' },
    sql:        { lineStart: '--',  lineEnd: '' },
    haskell:    { lineStart: '--',  lineEnd: '' },
    matlab:     { lineStart: '%',   lineEnd: '' },
    tex:        { lineStart: '%',   lineEnd: '' },
  };
  return styles[lang] ?? { lineStart: '//', lineEnd: '' };
}

/** 读取文件内容 */
export function readFileContent(fsPath: string): string | null {
  try {
    return fs.readFileSync(fsPath, 'utf-8');
  } catch {
    return null;
  }
}
