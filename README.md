# Scrum Poker

Self-hosted, real-time scrum poker (planning poker) at **https://poker.michael-zhang.com**.

Create a room and share the link. Everyone picks a card, and the cards stay hidden until someone reveals them. Then you talk it through and start a new round.

## Features

- **Rooms with no accounts.** Each room has an unguessable link. Join by typing a name. A room keeps its full state for 30 days of inactivity, and its link can be revived (same id, same deck, fresh round) for up to 90 days after the last activity. When the first person returns to an empty room that has been idle for 4 hours or more, the round starts clean and offline seats are dropped.
- **Decks.** Fibonacci, Modified Fibonacci, T-shirt sizes, Powers of 2, or a custom deck. Every built-in deck includes `?` and `☕`.
- **Hidden votes.** The server never sends anyone else's vote before the reveal. You only see that a person has voted.
- **Results.** Average, median, agreement %, a distribution chart, and a small celebration on consensus.
- **Spectator mode** for product owners and observers.
- **Shared countdown timer** (30s, 1m, 2m, 5m), corrected for each viewer's clock skew.
- **Emoji reactions** and **nudges**. A nudge shakes the cards of people who haven't voted and flashes their browser tab.
- **Survives reconnects and deploys.** A seat and its vote are held for 90 seconds after a disconnect. Rooms are saved to disk about 2 seconds after each change (with a 15-second safety net and a final save on shutdown), so a deploy doesn't end a session.
- Light and dark mode, mobile layout, and reduced-motion support.

## Development

```sh
nvm use            # Node 24+
npm install
npm run dev        # server on :3000 + Vite on :5173 (open http://localhost:5173)
npm run check      # typecheck + tests + production build (same as CI)
```

Layout:

| Path | What |
| --- | --- |
| `shared/protocol.ts` | Wire protocol types, decks, limits, and stats math. Used by both the server and the client. |
| `server/room.ts` | Pure room state machine: votes, reveal, deck, timer, presence, snapshots. |
| `server/app.ts` | HTTP (static files, `POST /api/rooms`, `/healthz`) and WebSocket (`/ws`), with rate limits and persistence. |
| `client/src` | React UI. No UI library, plain CSS. |
| `test/` | Vitest: room logic, stats, and end-to-end WebSocket tests against a real server. |

The server is TypeScript that Node 24 runs directly (type stripping), so it has no build step. Only the client is bundled.

## Production

```
Internet ─▶ Cloudflare ─▶ cloudflared (systemd, LXC 102) ─▶ 127.0.0.1:3000 ─▶ docker compose "scrum-poker"
```

- **Host:** Proxmox `192.168.50.4`, **LXC 102 `poker`**. It is an unprivileged Ubuntu 24.04 container with nesting enabled, 2 vCPU, 2 GB RAM and a 16 GB disk, and gets its address over DHCP. Nothing inbound depends on its IP, because both the tunnel and the runner connect outbound.
- **Ingress:** Cloudflare Tunnel `scrum-poker`, config at `/etc/cloudflared/config.yml` in the LXC. No router ports are open.
- **CI/CD:** `.github/workflows/ci-cd.yml`. The typecheck, test, build and Docker build run on GitHub-hosted runners. On a push to `main`, the `deploy` job runs on the self-hosted runner `poker-lxc` (label `poker`, user `runner`, in `/home/runner/actions-runner`). It runs `docker compose up -d --build --wait` and then a smoke test.
- **Data:** Docker volume `scrum-poker_poker-data` holds `/data/rooms.json`. Losing it ends every open room and every revivable link (tombstone).
- **Backups:** LXC 102 is in the weekly local vzdump job (Sunday 06:00) on the Proxmox host. It is deliberately left out of the hourly PBS job, which feeds the SnagDeals backup-heartbeat alert. The app is nearly stateless, so the README is enough to rebuild it.

### Ops cheatsheet

Run these from the Proxmox host (`ssh root@192.168.50.4`):

```sh
pct enter 102                                   # shell in the LXC
pct exec 102 -- docker compose -p scrum-poker ps
pct exec 102 -- docker logs --tail 100 scrum-poker-app-1
pct exec 102 -- curl -s localhost:3000/healthz   # {"ok":true,"rooms":N,"connections":N}
pct exec 102 -- systemctl status cloudflared actions.runner.*
```

To redeploy without a code change, use **Actions → CI/CD → Run workflow** on `main`.

### Limits and abuse protection

- Each IP can create 30 rooms per hour. Reviving an expired room counts as creating one. The server holds at most 10,000 live rooms, with up to 40 people per room.
- Each WebSocket connection is rate-limited to 10 messages per second, with bursts up to 30, and messages are capped at 4 KB. Binary frames cost a token too, and a socket that is rejected 50 times within 10 seconds is closed (1008).
- At most 5 sockets per client id in a room (the 6th is told `rate_limited` and closed) and 200 sockets per IP, which is generous because whole offices share one public IP (further upgrades get HTTP 429). A socket that has not joined a room within 10 seconds is closed (4000).
- `POST /api/rooms` bodies over 2 KB get HTTP 413.
- A WebSocket upgrade is only accepted from the same origin. The server sends a strict CSP, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, because other subdomains of the domain are not ours), `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`, so room links don't leak.
- **`CF-Connecting-IP` is trusted verbatim** for the per-IP limits. That is safe only because port 3000 is bound to loopback and reachable solely through cloudflared, which sets the header. Never expose the port directly, or anyone could pick their own "IP".

### Persistence

`/data/rooms.json` is `{ "version": 2, "rooms": [...], "tombstones": [...] }`; the legacy plain array of rooms still loads. Rooms are restored one by one, so a single bad entry is skipped (and logged) instead of dropping the rest. If the file cannot be parsed at startup it is renamed to `rooms.json.corrupt-<timestamp>` and the server logs an error and starts empty. Shutdown logs `saved N room(s)`; if that final save fails the process logs the error and exits non-zero.
