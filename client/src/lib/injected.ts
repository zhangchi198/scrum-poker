import type { RoomLookup } from '../../../shared/protocol.ts';
import { roomIdFromPath } from './invite.ts';

/**
 * For an invite link the server inlines the same JSON `GET /api/rooms/:id` would return, as
 * `<script type="application/json" id="room-lookup">`. It describes the room in the URL at page load, so it is
 * only handed out for that room and only while it is fresh (the head-count goes stale).
 */
let captured: { roomId: string; info: RoomLookup } | null = null;
const FRESH_MS = 60_000;

function valid(v: unknown): v is RoomLookup {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.deckLabel !== 'string') return false;
  if (o.status === 'revivable') return true;
  return o.status === 'live' && typeof o.story === 'string' && typeof o.players === 'number';
}

/** Reads (and removes) the inlined lookup. Call once, before rendering. */
export function captureInjectedLookup() {
  const el = document.getElementById('room-lookup');
  if (!el) return;
  try {
    const roomId = roomIdFromPath(location.pathname);
    const info: unknown = JSON.parse(el.textContent ?? '');
    if (roomId && valid(info)) captured = { roomId, info };
  } catch {
    /* malformed: fall back to fetching */
  }
  el.remove();
}

export function takeInjectedLookup(roomId: string): RoomLookup | null {
  return captured && captured.roomId === roomId && performance.now() < FRESH_MS ? captured.info : null;
}
