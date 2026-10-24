# engels: corp agents in cc

engels.corp.ts.net runs the Tailscale corp claudes (corp Claude account). It stays on the
corp tailnet only; nadya reaches its cchost through a tailcat tunnel that cchost runs on both
ends (host/tailcat.js). Design: nadya:~/nadya/research/corp-agents.html (user, Oct 24th).

    engels  cchost on 127.0.0.1:7691, CCX_HOSTS=engels (follows no other host)
            tailcat serve 7691,ssh, only nadya's client key (--allow)
    nadya   tailcat forward: 127.0.0.1:7691 -> engels's cchost, 127.0.0.1:2222 -> its ssh
            cchost lists engels as a third host, marked corp

engels's rows carry `corp: true` in `api/list?all=1` (the body has `corp: ["engels"]`), and
its usage and burn never reach api/usage, api/burn or the pace (remote.js `CORP`). Messages go
from nadya's sessions to engels's, never back: engels's cchost knows no other host.

## On engels (the user, or an agent there)

nadya cannot reach engels until this is done; nothing here was run on engels.

1. Install Deno, tmux, git, and Claude Code logged into the corp account. Start claudes in
   tmux, as on marx and nadya: cchost reads panes, not other terminals.
2. tailcat: on Linux the release binary,
   https://github.com/tailscale/tailcat/releases/tag/v0.7.0 (`tailcat_0.7.0_linux_amd64.tar.gz`,
   check it against `checksums.txt`), into a dir on PATH. v0.7.0 has no macOS binary; there
   build it with Go from the repo.
3. The code: `git clone git@github.com:fserb/cc.git ~/ai/cc` (or copy ~/ai/cc over).
4. A saved server key, so engels's tailcat address stays the same across restarts:

       tailcat genkey --key=default --fixed-region

   It prints engels's address (`tc...`). It holds the tunnel's pre-shared key: pass it to
   nadya as a file, not in a chat or a corp tool. On nadya it goes in
   `~/ai/apis/tailcat/engels.addr` (step 7).
5. nadya's ssh key, for the ssh that nadya's corp nightly run uses (`ssh engels`):

       mkdir -p ~/.config/cchost
       echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK/r1Gcts2y20yaxxXq20+3uWhsoqzcOU7b9LiZMkFmF fserb@fserb.com' > ~/.config/cchost/nadya-ssh.pub

6. `~/.config/cchost.env`:

       CCX_SELF=engels
       CCX_HOSTS=engels
       CCHOST_ARGS=--port 7691 --listen 127.0.0.1
       CCX_TAILCAT=nadya: serve --allow=nodekey:1993600f4282725e87e7323553649a2f20b5ba957add514e282793e1e640343c --ssh-authorized-keys=~/.config/cchost/nadya-ssh.pub 7691,ssh

   then `cd ~/ai/cc && ./task install` (a systemd user unit on Linux, launchd on macOS; it
   also adds the AskUserQuestion hook to ~/.claude/settings.json). On Linux, `loginctl
   enable-linger` keeps the user unit running with no one logged in. Check:
   `curl -s 127.0.0.1:7691/api/list | jq .tailcat` shows the serve link `running`.

   - port 7691, not 7681: nadya's own cchost has 7681, and the forward keeps the port, so
     the Host header nadya sends (`localhost:7691`) is engels's own port (server.js ownHost)
   - `--listen 127.0.0.1`: tailcat's serve connects from localhost; nothing on the corp
     tailnet reaches cchost
   - tailcat's `ssh` service is its own ssh server inside the tunnel (no sshd needed), a
     shell as the engels user for whoever holds both nadya's tailcat key and its ssh key

## On nadya (done Oct 24th, ccx-f)

- tailcat 0.7.0 in ~/.local/bin; nadya's client key in `~/ai/apis/tailcat/nadya.private.json`
  (`nadya.pub` is its public half; the dir is gitignored in ~/ai/apis)
- `~/.config/cchost.env`, read by cchost.service:

      CCX_HOSTS=marx,nadya,engels=localhost:7691
      CCX_CORP=engels
      CCX_TAILCAT=engels: forward --key=~/ai/apis/tailcat/nadya.private.json @~/ai/apis/tailcat/engels.addr 7691 2222:22

- `Host engels` in ~/.ssh/config: 127.0.0.1 port 2222

7. Once engels runs, put its address in `~/ai/apis/tailcat/engels.addr` (one line). cchost
   starts the forward within 30s, no restart. Check:
   `curl -s 127.0.0.1:7681/api/list?all=1 | jq '.tailcat, .down'`, then `ssh engels true`.
   Until then the link is `waiting` and engels is in `down`; every `ccx` call on nadya
   prints `engels: down, fetch failed` on stderr.

tailcat's forward does not redial a server that restarted (0.7.0, tried Oct 24th), so
cchost kills and restarts a forward whose host has been down a minute. Tried on nadya
against a local serve; not yet against engels.

## Not decided

- away mode on engels: cc's switch sets every host that answers, engels included, so corp
  agents' question boxes would be answered after 5 minutes too
- public tailcat DERP relays (now) or a self-run derper
