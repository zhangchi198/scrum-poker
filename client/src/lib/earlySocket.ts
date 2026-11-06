import { roomIdFromPath } from './invite.ts';
import { resumable } from './joined.ts';
import { mark } from './vitals.ts';

/**
 * On a room page where this browser already has a name and has joined before, open the WebSocket while the
 * bundle is still evaluating, instead of waiting for React to render and run its effects. useRoom adopts it.
 */
let early: { roomId: string; ws: WebSocket } | null = null;

export function openEarlySocket() {
  try {
    const roomId = roomIdFromPath(location.pathname);
    if (!roomId || !resumable(roomId)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.addEventListener('open', () => mark('wsOpen'));
    early = { roomId, ws };
    // Never leave an unclaimed socket behind (the join message is what keeps a server socket alive).
    setTimeout(() => {
      if (early?.ws === ws) {
        early = null;
        ws.close();
      }
    }, 5000);
  } catch {
    early = null;
  }
}

/** The pre-opened socket for this room, if there is a usable one. Each socket is handed out once. */
export function takeEarlySocket(roomId: string): WebSocket | null {
  const e = early;
  if (!e || e.roomId !== roomId) return null;
  early = null;
  if (e.ws.readyState === WebSocket.CONNECTING || e.ws.readyState === WebSocket.OPEN) return e.ws;
  return null;
}
