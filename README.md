# Scrum Poker

Self-hosted, real-time scrum poker (planning poker) at **https://poker.michael-zhang.com**.

Create a room and share the link. Everyone picks a card, and the cards stay hidden until someone reveals them. Then you talk it through and start a new round.

## Features

- **Rooms with no accounts.** Each room has an unguessable link. Join by typing a name. A room keeps its full state for 30 days of inactivity, and its link can be revived (same id, same deck, fresh round) for up to 90 days after the last activity. When the first person returns to an empty room that has been idle for 4 hours or more, the round starts clean and offline seats are dropped.
- **Decks.** Fibonacci, Modified Fibonacci, T-shirt sizes, Powers of 2, or a custom deck. Every built-in deck includes `?` and `☕`.
- **Hidden votes.** The server never sends anyone else's vote before the reveal. You only see that a person has voted.
- **Results.** Average, median, agreement %, a distribution chart, and a small celebration on consensus.
- **Spectator mode** for product owners and observers.
- **Shared countdown timer** (30s, 1m, 2m, 5m), corrected for each viewer's clock skew. It keeps running through the reveal and is cleared by a new round. **↻** restarts it with the same length. When it hits zero, everyone's browser plays a short, soft chime (WebAudio, no audio files) and a background tab's title flashes "⏰ Time's up" until you look at it. The 🔔/🔕 button turns the chime off for you only (remembered in this browser). Browsers only allow sound after you have clicked or typed on the page once, so the chime stays silent until then.
- **Undo for "Start new round" and "Change deck".** For 10 seconds everyone sees a toast ("Alex started a new round · Undo"). Undo restores the votes (still hidden if the round was not revealed), the reveal state, the round number, the deck and the timer. It is one level only, and it is refused once anything else has changed the round: a new vote, a reveal, another reset or deck change. Revealing is not undoable, because everyone has already seen the cards.
- **Facilitator controls (optional, off by default).** In Settings, "Only I can reveal, start new rounds, change the deck, edit the story and run the timer" makes you the facilitator. While it is on, the server rejects those actions (and Undo and removing offline seats) from everyone else with a clear error, and the buttons are disabled with a hint such as "Only Alex can reveal". Voting, reactions, nudges, spectator mode and name changes stay open to everyone. The facilitator's seat shows a badge and a "Make facilitator" button on everyone else's seat to hand the role over, and Settings turns the lock off. If the facilitator leaves or stays offline past the grace period, the lock releases by itself and everyone sees "Facilitator left — controls are open to everyone". The facilitator is stored as their private client id; other people only ever see a public id.
- **Offline seats.** A dimmed seat says "reconnecting…" for 15 seconds, then "away 1m" and so on. Anyone can remove an offline seat from its tooltip ("Remove from room"), which also drops their vote. People who are online can never be removed, and with the facilitator lock on only the facilitator can remove seats.
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
| `server/vitals.ts`, `scripts/vitals-summary.ts` | Real-user timing storage and its summary CLI (see "Real-user timing"). |
| `client/src` | Preact UI (React API through `preact/compat`, aliased in `vite.config.ts`). No UI library, plain CSS. |
| `test/` | Vitest: room logic, stats, and end-to-end WebSocket tests against a real server. |

The server is TypeScript that Node 24 runs directly (type stripping), so it has no build step. Only the client is bundled.

## Production

```
Internet ─▶ Cloudflare ─▶ cloudflared (systemd, in the LXC) ─▶ 127.0.0.1:3000 ─▶ docker compose "scrum-poker"
```

The production notes below describe the author's own deployment. To run your own copy, `docker compose up -d --build` behind any reverse proxy that sets `CF-Connecting-IP` (or change `server/app.ts` to read the header your proxy sets; see "Limits and abuse protection").

- **Host:** an unprivileged Ubuntu 24.04 LXC (`poker`) on a home Proxmox box, with nesting enabled, 2 vCPU, 2 GB RAM and a 16 GB disk. Nothing inbound depends on its IP, because the tunnel connects outbound and the deploy pulls.
- **Ingress:** Cloudflare Tunnel `scrum-poker`, config at `/etc/cloudflared/config.yml` in the LXC. No router ports are open.
- **CI:** `.github/workflows/ci.yml` runs typecheck, tests, the client build and a Docker build on GitHub-hosted runners, for pull requests and pushes to `main`. When they pass on a push to `main`, its `promote` job fast-forwards the **`prod` branch** to that commit (fast-forward only, so a slower older run can't move prod back). Don't push to `prod` by hand: whatever is on it gets deployed.
- **Deploy (pull-based):** `deploy/poker-deploy.sh`, installed as `/usr/sbin/poker-deploy` with the units in `deploy/systemd/`. `poker-deploy.timer` runs it every 2 minutes. It fetches `prod` into `/opt/scrum-poker` over SSH with a read-only deploy key (`/root/.ssh/id_ed25519`, titled `poker-lxc-deploy` under the repo's Deploy keys) and, when `prod` moved, runs `docker compose build --pull`, then `up -d --wait`, then a smoke test (`/healthz` must report the new short SHA). A failed deploy rolls back to the previous commit, and that commit is skipped until `prod` moves again. So merging to `main` deploys about 1–3 minutes after CI goes green. There is deliberately no self-hosted GitHub runner: GitHub never executes anything on the box, so pull requests, including ones from forks, cannot reach it.
- **Weekly rebuild:** `poker-rebuild.timer` (Sunday 08:00 UTC) redeploys the current commit with `build --pull`, so `node:24-alpine` OS and Node patches reach prod even when nothing in the repo changed.
- **Data:** Docker volume `scrum-poker_poker-data` holds `/data/rooms.json`. Losing it ends every open room and every revivable link (tombstone).
- **Backups:** the LXC is in a weekly local vzdump job on the Proxmox host, deliberately separate from the hourly backup job of another project on the same box. The app is nearly stateless, so the README is enough to rebuild it.

### Ops cheatsheet

Inside the LXC (from the Proxmox host: `pct enter <ctid>`):

```sh
docker compose -p scrum-poker ps
docker logs --tail 100 scrum-poker-app-1
curl -s localhost:3000/healthz                  # {"ok":true,"version":"<short commit sha>","rooms":N,"connections":N}
systemctl status cloudflared poker-deploy.timer poker-rebuild.timer
journalctl -u poker-deploy -u poker-rebuild -n 50   # deploy history
systemctl start poker-rebuild                   # redeploy now without a code change
cat /var/lib/poker-deploy/{deployed,failed}     # deployed SHA, and a skipped bad SHA if any
git -C /opt/scrum-poker log -1 --oneline origin/prod   # what prod points at
```

Installing or updating the deploy itself (as root in the LXC; needs `git`, `jq`, `curl`, Docker with compose, and the deploy key above with `github.com` in `/root/.ssh/known_hosts`):

```sh
install -m 0755 /opt/scrum-poker/deploy/poker-deploy.sh /usr/sbin/poker-deploy
install -m 0644 /opt/scrum-poker/deploy/systemd/poker-* /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now poker-deploy.timer poker-rebuild.timer
```

The script does not install itself, so a change to `deploy/` only takes effect after these lines are re-run.

### Limits and abuse protection

- Each IP can create 30 rooms per hour. Reviving an expired room counts as creating one. The server holds at most 10,000 live rooms, with up to 40 people per room.
- Each WebSocket connection is rate-limited to 10 messages per second, with bursts up to 30, and messages are capped at 4 KB. Binary frames cost a token too, and a socket that is rejected 50 times within 10 seconds is closed (1008).
- At most 5 sockets per client id in a room (the 6th is told `rate_limited` and closed) and 200 sockets per IP, which is generous because whole offices share one public IP (further upgrades get HTTP 429). A socket that has not joined a room within 10 seconds is closed (4000).
- `POST /api/rooms` bodies over 2 KB get HTTP 413.
- `GET /api/rooms/:id` (used by the room page to check a room exists before asking for a name) returns only the story, the number of connected voters and the deck name, never a vote. It is limited to 60 requests per minute per IP. An invite link (`GET /r/<id>`) carries the same JSON inline as `<script type="application/json" id="room-lookup">` (with `<` escaped), so the page needs no extra round trip. That counts against the same per-IP budget; once it is spent the plain page is served and the client fetches instead. Such a response is `Cache-Control: private, no-store` with no validators, so neither browsers nor Cloudflare keep per-room HTML. The shell and assets send `ETag`/`Last-Modified` and answer 304.
- A WebSocket upgrade is only accepted from the same origin. The server sends a strict CSP, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, because other subdomains of the domain are not ours), `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`, so room links don't leak.
- **`CF-Connecting-IP` is trusted verbatim** for the per-IP limits. That is safe only because port 3000 is bound to loopback and reachable solely through cloudflared, which sets the header. Never expose the port directly, or anyone could pick their own "IP".

### Real-user timing

Every page load sends one `navigator.sendBeacon('/api/vitals')` once the room is interactive, 10 seconds after load, or when the tab is hidden, whichever is first. It carries Navigation Timing (DNS, connect, TLS, TTFB, DOMContentLoaded, load), first/largest contentful paint, app milestones (room lookup, WebSocket open, `welcome`, first hand render), `cold` (the document came over the network), `nextHopProtocol`, `effectiveType`, viewport size and a coarse "Browser/OS" label, plus the page kind (`home`, `room`, `join`, `other`). A room id, URL, name or vote is never included, and neither is the IP address.

- **Limits:** bodies over 4 KB get 413; numbers are clamped and strings truncated; 30 beacons per IP per hour and 2000 per day overall (429). The reply is 204.
- **Storage:** `vitals.jsonl` next to `DATA_FILE` (memory only without it), rotated to `vitals.jsonl.1` at about 5 MB.
- **Reading it:** `docker exec scrum-poker-app-1 node scripts/vitals-summary.ts [-n 20] [--cold]` prints the last records and p50/p90 per metric per page kind (`npm run vitals -- --file path` locally).

### Feedback email

Users can send feedback from the home page footer or from a room's Settings dialog (**Send feedback**). Each message is stored, and the owner gets an email digest.

- **Digest rule:** at most one email per rolling 24 hours. When feedback arrives and no email has gone out in the last 24h (or ever), one email with everything unsent is sent immediately. Anything that arrives later is held and sent together in a single email once 24h have passed since the last one (checked on every submission and every 10 minutes). If SMTP fails, nothing is marked as sent and the next check retries; a failure does not count as the day's email. An email carries at most 100 items, and the rest follow in the next digest.
- **Storage:** `feedback.jsonl` (one JSON line per message) and `feedback-mail.json` (`lastSentAt` and the ids already emailed) sit next to `DATA_FILE`, in the `/data` volume, so restarts neither resend nor lose track. The IP address is never stored. The only context sent is the page kind (`home` or `room`), viewport size and user agent. A room id or URL is never included.
- **Limits:** `POST /api/feedback` takes at most 8 KB (413 above), 5 messages per IP per hour and 200 per day overall (429).
- **Email:** plain text only. Subject `Scrum Poker feedback: N new (B bugs, I ideas, O other)`; times are shown in UTC and America/Toronto; Reply-To is set when the digest has exactly one address-like contact.
- **Config:** environment variables `SMTP_USER`, `SMTP_PASS`, `FEEDBACK_TO` (all three required), plus optional `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `465`, TLS) and `FEEDBACK_FROM` (default `SMTP_USER`). Without the three required ones the app logs `feedback email disabled (no SMTP config)` and only stores feedback. `compose.yaml` reads them from the optional file `/etc/scrum-poker/mail.env`, which is never committed.

One-time setup: create a Gmail app password at https://myaccount.google.com/apppasswords (2-step verification must be on). Install `deploy/poker-set-mail.sh` on the LXC as `/usr/sbin/poker-set-mail` (root, mode 0750). Use `/usr/sbin` because `pct exec` runs commands with `PATH=/sbin:/bin:/usr/sbin:/usr/bin`, so a command in `/usr/local/sbin` is not found, then run this in a terminal (**not** through an AI chat, the script asks for the password):

```sh
ssh -t root@<proxmox-host> "pct exec <ctid> -- poker-set-mail <your gmail address>"
```

It writes `/etc/scrum-poker/mail.env` (root:root, 0600), recreates the app container, sends a test feedback and prints the mail log lines. Re-run it to rotate the password.

### Persistence

`/data/rooms.json` is `{ "version": 2, "rooms": [...], "tombstones": [...] }`; the legacy plain array of rooms still loads. Each room also stores its `facilitator` (the private client id, or `null`); files written before the lock existed have no such field and load as unlocked. The 10-second undo snapshot is memory only and is not saved. Rooms are restored one by one, so a single bad entry is skipped (and logged) instead of dropping the rest. If the file cannot be parsed at startup it is renamed to `rooms.json.corrupt-<timestamp>` and the server logs an error and starts empty. Shutdown logs `saved N room(s)`; if that final save fails the process logs the error and exits non-zero.

## Dependency updates

- **Dependabot** (`.github/dependabot.yml`) opens PRs for npm packages and the Docker base image weekly (Monday 06:00 Toronto, with routine minor and patch bumps grouped into one PR), and for GitHub Actions monthly. GitHub security advisories also trigger immediate security-update PRs. Major bumps of the Node base image, `@types/node` and `typescript` are ignored on purpose: prod stays on the Node 24 LTS line, and a TypeScript 7 move is a planned migration. PRs only run CI on GitHub-hosted runners. The box only ever pulls `main`, so unmerged dependency code never runs on it.
- **Weekly rebuild:** see "Weekly rebuild" under Production.

## License

[MIT](LICENSE)
