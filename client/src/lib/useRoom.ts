import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, ErrorCode, RoomView, ServerMsg } from '../../../shared/protocol.ts';
import type { Identity } from './identity.ts';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting';

export interface RoomEvents {
  onReaction?: (r: { from: string; name: string; emoji: string }) => void;
  onNudge?: (fromName: string) => void;
  onError?: (code: ErrorCode, message: string) => void;
}

/**
 * Keeps one WebSocket to the room alive (with backoff reconnects) and exposes the latest room view.
 * Fatal errors (room gone / full) stop reconnecting and surface via `fatal`.
 */
export function useRoom(roomId: string, identity: Identity | null, events: RoomEvents) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [fatal, setFatal] = useState<{ code: ErrorCode; message: string } | null>(null);
  const [clockOffset, setClockOffset] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const hasIdentity = identity !== null;
  const clientId = identity?.clientId;

  useEffect(() => {
    if (!hasIdentity || !clientId) return;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        const id = identityRef.current!;
        ws.send(JSON.stringify({ t: 'join', roomId, clientId: id.clientId, name: id.name, spectator: id.spectator } satisfies ClientMsg));
        // Keep idle connections from being dropped by proxies (Cloudflare closes after ~100s idle).
        pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 25_000);
      };

      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data as string) as ServerMsg;
        } catch {
          return;
        }
        switch (msg.t) {
          case 'welcome':
            setYou(msg.you);
            setStatus('open');
            setRoom(msg.room);
            setClockOffset(msg.room.now - Date.now());
            break;
          case 'state':
            setRoom(msg.room);
            setClockOffset(msg.room.now - Date.now());
            break;
          case 'reaction':
            eventsRef.current.onReaction?.(msg);
            break;
          case 'nudge':
            eventsRef.current.onNudge?.(msg.fromName);
            break;
          case 'error':
            if (msg.code === 'room_not_found' || msg.code === 'room_full') {
              stopped = true;
              setFatal({ code: msg.code, message: msg.message });
              ws.close();
            } else {
              eventsRef.current.onError?.(msg.code, msg.message);
            }
            break;
        }
      };

      ws.onclose = () => {
        clearInterval(pingTimer);
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) return;
        setStatus('reconnecting');
        const delay = Math.min(10_000, 400 * 2 ** attempt++) * (0.75 + Math.random() * 0.5);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    // Reconnect immediately when a phone wakes up / the tab comes back, instead of waiting out the backoff.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !wsRef.current && !stopped) {
        clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [roomId, hasIdentity, clientId]);

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { room, you, status, fatal, clockOffset, send };
}
