import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, ErrorCode, RoomView, ServerMsg } from '../../../shared/protocol.ts';

/** What the join message carries. Read afresh on every (re)connect so it is never a stale copy. */
export interface JoinInfo {
  clientId: string;
  name: string;
  spectator: boolean;
}

export type ConnStatus = 'connecting' | 'open' | 'reconnecting';

export interface RoomEvents {
  onReaction?: (r: { from: string; name: string; emoji: string }) => void;
  onNudge?: (fromName: string) => void;
  onError?: (code: ErrorCode, message: string) => void;
}

/**
 * Keeps one WebSocket to the room alive (with backoff reconnects) and exposes the latest room view.
 * Fatal errors (room gone / full) stop reconnecting and surface via `fatal`. Any other error that arrives before
 * the welcome (for example a refused revival) stops reconnecting too and surfaces via `joinError`; `retry` reconnects.
 */
export function useRoom(roomId: string, enabled: boolean, getJoinInfo: () => JoinInfo, events: RoomEvents) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [fatal, setFatal] = useState<{ code: ErrorCode; message: string } | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [tryNonce, setAttempt] = useState(0);
  const [clockOffset, setClockOffset] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const joinInfoRef = useRef(getJoinInfo);
  joinInfoRef.current = getJoinInfo;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    if (!enabled) return;
    setJoinError(null);
    setStatus('connecting');
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;
      let welcomed = false;

      ws.onopen = () => {
        attempt = 0;
        const id = joinInfoRef.current();
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
            welcomed = true;
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
            } else if (!welcomed) {
              // Refused before we got in (e.g. an expired room that could not be revived): say so, don't retry silently.
              stopped = true;
              setJoinError(msg.message);
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
  }, [roomId, enabled, tryNonce]);

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { room, you, status, fatal, joinError, retry, clockOffset, send };
}
