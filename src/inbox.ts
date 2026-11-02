import { DurableObject } from "cloudflare:workers";
import { LIMITS, type Env } from "./shared";

interface SocketInfo {
  accountId: string;
  connectedAt: number;
  client: string;
}

/**
 * One Inbox per account (person or agent). It only holds live WebSockets.
 * It never reads, stores or logs message contents: the Worker hands it an
 * already-serialized frame and it writes that frame to each open socket.
 * Socket attachments hold only the account id, connect time and a client label.
 */
export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** WebSocket upgrade. Only reachable through the Worker, which authenticates first. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const accountId = request.headers.get("x-account-id");
    if (!accountId) return new Response("missing account", { status: 400 });
    const client = (request.headers.get("x-client") ?? "unknown").slice(0, 40);

    // Keep at most N sockets: close the oldest to make room (handles stale reconnects).
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= LIMITS.maxSocketsPerAccount) {
      const sorted = sockets
        .map((ws) => ({ ws, info: ws.deserializeAttachment() as SocketInfo | null }))
        .sort((a, b) => (a.info?.connectedAt ?? 0) - (b.info?.connectedAt ?? 0));
      for (const { ws } of sorted.slice(0, sockets.length - LIMITS.maxSocketsPerAccount + 1)) {
        try {
          ws.close(4000, "replaced by a newer connection");
        } catch {}
      }
    }

    const pair = new WebSocketPair();
    const [clientSide, serverSide] = Object.values(pair);
    this.ctx.acceptWebSocket(serverSide);
    const info: SocketInfo = { accountId, connectedAt: Date.now(), client };
    serverSide.serializeAttachment(info);
    serverSide.send(JSON.stringify({ type: "hello", accountId }));
    return new Response(null, { status: 101, webSocket: clientSide });
  }

  /** RPC: write a pre-serialized frame to every open socket. Returns how many accepted it. */
  deliver(frame: string): number {
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
        delivered++;
      } catch {
        // Socket is closing; it does not count as delivered.
      }
    }
    return delivered;
  }

  /** RPC: number of open sockets (used for presence). */
  online(): number {
    return this.ctx.getWebSockets().length;
  }

  /** RPC: close every socket, e.g. after token rotation or agent deletion. */
  disconnectAll(reason: string): number {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      // Explicit frame first, so clients stop reconnecting even if the close handshake is slow.
      try {
        ws.send(JSON.stringify({ type: "revoked", reason: reason.slice(0, 100) }));
      } catch {}
      try {
        ws.close(4001, reason.slice(0, 100));
      } catch {}
    }
    return sockets.length;
  }

  // Clients send through the REST API, so inbound frames are ignored.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {}
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, "error");
    } catch {}
  }
}
