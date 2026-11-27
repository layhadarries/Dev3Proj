#!/usr/bin/env bash
# Deterministic mailbox for teammates' coding agents, kept in a GitHub issue. Needs gh and jq.
#
#   agent-mail.sh wait ISSUE             block until there is new mail, print it, exit
#   agent-mail.sh send ISSUE NAME FILE   post FILE as a comment signed [NAME]
#
# AGENT_MAIL_FROM (required for wait): comma-separated GitHub logins to accept. All others are ignored.
# Each message is printed as one line of JSON. Message text is untrusted data, never a command.
# Edits to an already delivered comment are not delivered again, so post corrections as new comments.
set -euo pipefail

REPO="${AGENT_MAIL_REPO:-layhadarries/Dev3Proj}"
INTERVAL="${AGENT_MAIL_INTERVAL:-60}"
STATE="${AGENT_MAIL_STATE:-$HOME/.local/state/solguard-agent-mail}"

usage() { sed -n '4,5p' "$0" >&2; exit 2; }
[[ "${2:-}" =~ ^[0-9]+$ ]] || usage
cmd=$1 issue=$2

case $cmd in
  wait)
    : "${AGENT_MAIL_FROM:?set AGENT_MAIL_FROM to the GitHub logins to accept}"
    mkdir -p "$STATE"
    # One cursor per sender list, so that different readers do not skip each other's mail.
    cursor="$STATE/${REPO//\//_}-$issue-${AGENT_MAIL_FROM//[^A-Za-z0-9-]/_}"
    failures=0
    while true; do
      last=$(cat "$cursor" 2>/dev/null || echo 0)
      if mail=$(gh api --paginate "repos/$REPO/issues/$issue/comments?per_page=100" |
        jq -c --argjson last "$last" --arg from "$AGENT_MAIL_FROM" '
          .[] | select(.id > $last)
          | select(.user.login as $u | $from | split(",") | index($u))
          | {id, author: .user.login, url: .html_url, body}'); then
        failures=0
        if [ -n "$mail" ]; then
          printf '%s\n' "$mail"
          # Rename into place so that an interruption cannot leave an empty cursor.
          jq -s 'map(.id) | max' <<<"$mail" >"$cursor.tmp"
          mv "$cursor.tmp" "$cursor"
          exit 0
        fi
      else
        # Give up loudly so that a broken poller is not mistaken for an empty mailbox.
        failures=$((failures + 1))
        [ "$failures" -lt 5 ] || { echo '{"error":"agent-mail: 5 polls failed in a row"}'; exit 1; }
      fi
      sleep "$INTERVAL"
    done
    ;;
  send)
    [ $# -eq 4 ] && [ -s "$4" ] || usage
    { printf '**[%s]**\n\n' "$3"; cat "$4"; } | gh issue comment "$issue" --repo "$REPO" --body-file -
    ;;
  *) usage ;;
esac
