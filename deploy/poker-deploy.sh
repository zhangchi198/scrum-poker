#!/usr/bin/env bash
# Pull-based deploy for the poker LXC. Installed as /usr/sbin/poker-deploy and run as root by
# poker-deploy.timer (every 2 minutes) and poker-rebuild.timer (weekly, with --rebuild).
#
# The box pulls from GitHub; GitHub never runs anything on the box. There is no self-hosted
# runner, so a pull request (including one from a fork of this public repo) cannot reach it.
#
# Each run:
#   1. fetches origin/main into /opt/scrum-poker;
#   2. if main moved, waits until GitHub's "Typecheck, test, build" check passed on that commit;
#   3. builds with --pull, restarts with --wait, smoke-tests, and records the deployed SHA;
#   4. if the new build fails, redeploys the previous SHA and skips the bad one until main moves.
# --rebuild redeploys the current SHA anyway, so base-image OS and Node patches land weekly.
#
# Logs: journalctl -u poker-deploy (and -u poker-rebuild).
set -euo pipefail

REPO_URL=https://github.com/zhangchi198/scrum-poker.git
API=https://api.github.com/repos/zhangchi198/scrum-poker
CHECK_NAME='Typecheck, test, build'
SRC=/opt/scrum-poker
STATE=/var/lib/poker-deploy
PROJECT=scrum-poker

rebuild=0
[[ "${1:-}" == "--rebuild" ]] && rebuild=1

mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { echo "another deploy is running"; exit 0; }

if [[ ! -d "$SRC/.git" ]]; then
  git clone --quiet "$REPO_URL" "$SRC"
fi
git -C "$SRC" fetch --quiet origin main
target="$(git -C "$SRC" rev-parse origin/main)"
deployed="$(cat "$STATE/deployed" 2>/dev/null || true)"
failed="$(cat "$STATE/failed" 2>/dev/null || true)"

if [[ "$target" == "$deployed" && $rebuild -eq 0 ]]; then
  exit 0
fi
if [[ "$target" == "$failed" ]]; then
  # A skipped bad commit: the weekly rebuild refreshes what is running instead.
  [[ $rebuild -eq 1 && -n "$deployed" ]] || exit 0
  target="$deployed"
fi

# CI gate: only deploy a commit whose check run on main succeeded.
# Unauthenticated API (60 req/h per IP), called only while a new commit is waiting.
if [[ "$target" != "$deployed" ]]; then
  runs="$(curl -fsS -H 'Accept: application/vnd.github+json' \
    "$API/commits/$target/check-runs?check_name=$(jq -rn --arg n "$CHECK_NAME" '$n|@uri')")" \
    || { echo "GitHub API unreachable; will retry"; exit 0; }
  status="$(jq -r '[.check_runs[] | select(.app.slug == "github-actions")][0] | "\(.status) \(.conclusion)"' <<<"$runs")"
  case "$status" in
    "completed success") ;;
    "completed "*) echo "CI did not pass on ${target:0:7} ($status); not deploying"; echo "$target" >"$STATE/failed"; exit 1 ;;
    *) echo "waiting for CI on ${target:0:7} ($status)"; exit 0 ;;
  esac
fi

# Every step has an explicit "|| return 1": bash ignores set -e inside a function called from "if".
deploy() {
  local sha="$1" health
  git -C "$SRC" checkout --quiet --force --detach "$sha" || return 1
  cd "$SRC" || return 1
  GIT_SHA="$sha" docker compose -p "$PROJECT" build --pull --quiet || return 1
  GIT_SHA="$sha" docker compose -p "$PROJECT" up -d --wait --wait-timeout 60 || return 1
  health="$(curl -fsS http://127.0.0.1:3000/healthz)" || return 1
  jq -e --arg v "${sha:0:7}" '.ok == true and .version == $v' <<<"$health" >/dev/null \
    || { echo "healthz mismatch: $health"; return 1; }
  curl -fsS http://127.0.0.1:3000/ | grep -q '<div id="root">' || { echo "home page smoke test failed"; return 1; }
}

prev="${deployed:0:7}"
note=""
[[ $rebuild -eq 1 ]] && note=", weekly rebuild"
echo "deploying ${target:0:7} (was ${prev:-none}$note)"
if deploy "$target"; then
  echo "$target" >"$STATE/deployed"
  rm -f "$STATE/failed"
  docker image prune -f >/dev/null
  echo "deployed ${target:0:7}"
  exit 0
fi

echo "deploy of ${target:0:7} FAILED"
echo "$target" >"$STATE/failed"
if [[ -n "$deployed" && "$deployed" != "$target" ]]; then
  echo "rolling back to ${deployed:0:7}"
  deploy "$deployed" && echo "rolled back to ${deployed:0:7}" || echo "ROLLBACK FAILED"
fi
exit 1
