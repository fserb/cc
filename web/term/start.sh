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
# on the pane (which a window with several makes its active pane for everyone too), attached
# with ignore-size: the user's clients stay on their windows, and destroy-unattached
# drops it when the page closes. tmux honours ignore-size only while some client without it is
# attached somewhere, so a control client sits on a throwaway session of its own (its size
# reaches only that session); the hangup when ssh closes ends it. new-session takes the
# terminal's size, so it gets the window's own.
attach="p=$pane
$(cat <<'EOF'
s=$(tmux display -p -t "$p" '#{session_id}') || exit 1
w=$(tmux display -p -t "$p" '#{window_id}')
x=$(tmux display -p -t "$p" '#{window_width}')
y=$(tmux display -p -t "$p" '#{window_height}')
g=cc-term-$$ h=cc-term-hold-$$
{ echo 'set destroy-unattached on'; echo 'refresh-client -C 10x10'; exec sleep 86400; } | tmux -C new-session -s $h >/dev/null 2>&1 &
trap 'kill 0' EXIT
until [ "$(tmux list-clients -t $h -F '#{client_width}' 2>/dev/null)" = 10 ]; do sleep 0.05; done
tmux new-session -d -x $x -y $y -t "$s" -s $g \; set -t $g destroy-unattached on \; set -t $g status off \; select-window -t "$g:$w" \; select-pane -t "$p" \; attach -f ignore-size -t $g
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
