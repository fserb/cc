#!/bin/sh
# ttyd -H X-Term-Ip puts the caller's address in TTYD_USER (Caddy's X-Forwarded-For, copied by
# nginx). Only my tailnet logins get the passwordless ssh key.
ip=${TTYD_USER%%,*}
login=$(jq -r --arg ip "$ip" '.[$ip].login // empty' /global/tailscale.json)
case "$login" in
fernando.serboncini@gmail.com | fserb@tailscale.com) ;;
*)
  echo "not allowed: $ip $login"
  sleep 3600
  exit 1
  ;;
esac

# term/?arg=<host>&arg=<pane id>
host=$1 pane=$2
case "$host" in nadya | marx) ;; *) echo "bad host: $host"; sleep 3600; exit 1 ;; esac
case "$pane" in %*[!0-9]* | % | "") echo "bad pane: $pane"; sleep 3600; exit 1 ;; %*) ;; *) echo "bad pane: $pane"; sleep 3600; exit 1 ;; esac

# Run on the pane's host. A session of our own grouped with the pane's, on the pane's window,
# on the pane (which a window with several makes its active pane for everyone too), attached as
# a plain client: the user's clients stay on their windows, and destroy-unattached drops it when
# the page closes. Both hosts run tmux's default window-size latest, so the window takes this
# client's size, follows the page as it resizes, and goes back to the user's terminal as soon
# as they type there.
attach="p=$pane
$(cat <<'EOF'
s=$(tmux display -p -t "$p" '#{session_id}') || exit 1
w=$(tmux display -p -t "$p" '#{window_id}')
g=cc-term-$$
tmux new-session -d -t "$s" -s $g \; set -t $g destroy-unattached on \; set -t $g status off \; select-window -t "$g:$w" \; select-pane -t "$p" \; attach -t $g
EOF
)"

# a shell command that runs $1 in a login zsh, carried as base64 so no quoting crosses ssh
shq() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
cmd() { echo "zsh -lc $(shq "eval \"\$(echo $(printf %s "$1" | base64 | tr -d '\n') | base64 -d)\"")"; }

run=$(cmd "$attach")
[ "$host" = marx ] && run=$(cmd "exec ssh -t marx $(shq "$run")")

gw=$(ip route | awk '/default/ {print $3}')
exec ssh -t \
  -i /data/id_ed25519 \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=/data/known_hosts \
  "fserb@$gw" "$run"
