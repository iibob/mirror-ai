import { EventEmitter } from 'events';
import * as http from 'http';

// 动态 require ws（兼容 CommonJS）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = require('ws');

export interface WsMessage {
  type: string;
  data?: unknown;
}

export class MirrorAiWebSocketServer extends EventEmitter {
  private wss: InstanceType<typeof WebSocket.Server> | undefined;
  private clients: Set<InstanceType<typeof WebSocket>> = new Set();
  private readonly port: number;
  private httpServer: http.Server | undefined;

  constructor(port: number = 8765) {
    super();
    this.port = port;
  }

  start(): void {
    // 创建 HTTP 服务器，用于承载 WebSocket
    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Mirror Ai WebSocket Server');
    });

    this.wss = new WebSocket.Server({ server: this.httpServer });

    this.wss.on('connection', (ws: InstanceType<typeof WebSocket>) => {
      console.log('[MirrorAi] Chrome 插件已连接');
      this.clients.add(ws);
      this.emit('clientConnected', this.clients.size);

      ws.on('message', (raw: Buffer | string) => {
        try {
          const msg: WsMessage = JSON.parse(raw.toString());
          this.handleIncoming(msg, ws);
        } catch (e) {
          console.error('[MirrorAi] 消息解析失败:', e);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log('[MirrorAi] Chrome 插件已断开');
        this.emit('clientDisconnected', this.clients.size);
      });

      ws.on('error', (err: Error) => {
        console.error('[MirrorAi] WebSocket 错误:', err.message);
        this.clients.delete(ws);
        this.emit('clientDisconnected', this.clients.size);
      });

      // 立即发送握手确认
      this.sendTo(ws, { type: 'hello', data: { version: '1.0.0' } });
    });

    this.httpServer.listen(this.port, '127.0.0.1', () => {
      console.log(`[MirrorAi] WebSocket 服务已启动，端口 ${this.port}`);
      this.emit('started', this.port);
    });

    this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[MirrorAi] 端口 ${this.port} 已被占用，请关闭其他实例`);
        this.emit('error', `端口 ${this.port} 已被占用`);
      } else {
        this.emit('error', err.message);
      }
    });
  }

  private handleIncoming(msg: WsMessage, _ws: InstanceType<typeof WebSocket>): void {
    switch (msg.type) {
      case 'response':
        // Chrome 插件返回了回复
        this.emit('aiResponse', msg.data);
        break;

      case 'status':
        // Chrome 插件状态更新（连接状态、页面状态）
        this.emit('statusUpdate', msg.data);
        break;

      case 'error':
        // Chrome 插件报错
        this.emit('remoteError', msg.data);
        break;

      case 'ping':
        // 心跳，不需要处理（WebSocket 保持连接即可）
        break;

      default:
        console.warn('[MirrorAi] 未知消息类型:', msg.type);
    }
  }

  /** 向所有已连接的 Chrome 插件广播 */
  broadcast(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendTo(ws: InstanceType<typeof WebSocket>, msg: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  stop(): void {
    this.wss?.close();
    this.httpServer?.close();
    this.clients.clear();
    console.log('[MirrorAi] WebSocket 服务已停止');
  }

  get isRunning(): boolean {
    return !!this.httpServer?.listening;
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
