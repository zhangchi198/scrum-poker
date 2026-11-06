#!/usr/bin/env bash
# Interactive, one-time (or password-rotation) setup of the feedback email on the poker LXC.
# Install on the LXC as /usr/sbin/poker-set-mail (pct exec uses PATH=/sbin:/bin:/usr/sbin:/usr/bin) and run as root:
#
#   ssh -t root@192.168.50.4 "pct exec 102 -- poker-set-mail <your gmail address>"
#
# Run it in a real terminal, not through an AI chat: it asks for a Gmail app password
# (https://myaccount.google.com/apppasswords), which must never be pasted anywhere else.
#
# It writes /etc/scrum-poker/mail.env (root:runner, 0640), recreates the app container so it
# picks the file up, sends one test feedback, and prints the mail-related container log lines.
set -euo pipefail

CHECKOUT=/home/runner/actions-runner/_work/scrum-poker/scrum-poker
ENV_FILE=/etc/scrum-poker/mail.env
DEFAULT_ADDR="${1:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi
if [[ ! -t 0 ]]; then
  echo "This needs an interactive terminal (ssh -t ...)." >&2
  exit 1
fi
if [[ ! -f "$CHECKOUT/compose.yaml" ]]; then
  echo "Cannot find the runner checkout at $CHECKOUT (has the first deploy run?)." >&2
  exit 1
fi

read -r -p "SMTP user (Gmail address)${DEFAULT_ADDR:+ [$DEFAULT_ADDR]}: " smtp_user
smtp_user="${smtp_user:-$DEFAULT_ADDR}"
read -r -p "Send feedback to${DEFAULT_ADDR:+ [$DEFAULT_ADDR]}: " feedback_to
feedback_to="${feedback_to:-$DEFAULT_ADDR}"
if [[ -z "$smtp_user" || -z "$feedback_to" ]]; then
  echo "An address is required (pass it as the first argument or type it)." >&2
  exit 1
fi
read -r -s -p "Gmail app password (input hidden): " smtp_pass
echo
# Google shows app passwords in groups of four with spaces; SMTP wants them without.
smtp_pass="${smtp_pass// /}"
if [[ -z "$smtp_pass" ]]; then
  echo "No password entered; nothing changed." >&2
  exit 1
fi
# The env file is KEY=value per line, so refuse anything that could add lines.
for v in "$smtp_user" "$feedback_to" "$smtp_pass"; do
  if [[ "$v" == *$'\n'* || "$v" == *$'\r'* ]]; then
    echo "Values must be a single line." >&2
    exit 1
  fi
done

install -d -m 0750 -o root -g runner "$(dirname "$ENV_FILE")"
umask 027
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  printf 'SMTP_USER=%s\n' "$smtp_user"
  printf 'SMTP_PASS=%s\n' "$smtp_pass"
  printf 'FEEDBACK_TO=%s\n' "$feedback_to"
} >"$tmp"
unset smtp_pass
chown root:runner "$tmp"
chmod 0640 "$tmp"
mv "$tmp" "$ENV_FILE"
trap - EXIT
echo "Wrote $ENV_FILE (root:runner, 0640)."

echo "Recreating the app container..."
(cd "$CHECKOUT" && docker compose up -d --force-recreate --wait app)

echo "Sending a test feedback..."
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/feedback \
  -H 'Content-Type: application/json' \
  --data '{"type":"other","message":"Test message from poker-set-mail. If this reached your inbox, feedback email works.","page":"home","viewport":"setup-script","userAgent":"poker-set-mail"}')"
echo "POST /api/feedback -> HTTP $code (201 means stored)"
sleep 5

echo "--- mail-related container log lines ---"
docker logs --tail 200 scrum-poker-app-1 2>&1 | grep -i 'feedback' || echo "(no feedback lines found)"
echo "---"
echo "Expect 'feedback email sent' above. If you see 'feedback email failed', check the app password and that 2-step verification is on."
echo "Note: only one email goes out per 24h. If a digest was already sent today, the test message waits for the next one."
