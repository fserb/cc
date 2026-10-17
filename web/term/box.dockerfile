# cc's desktop Terminal view: ttyd serves xterm.js and runs ssh to nadya (and from there to
# marx), attaching to one Claude session's tmux pane. Copied from marx:~/web/wetty. nginx
# passes the caller's address to ttyd; start.sh checks the tailnet login and uses the key in
# /data. ttyd -a takes the host and pane from the URL: term/?arg=<host>&arg=<%pane>
FROM tsl0922/ttyd:alpine
RUN apk add --no-cache openssh-client jq nginx
COPY start.sh nginx.conf /box/
LABEL box.idle="off"
EXPOSE 7681
ENTRYPOINT ["sh", "-c", "ttyd -W -a -i lo -p 7682 -H X-Term-Ip -t titleFixed=cc -t fontSize=14 -t 'fontFamily=Inconsolata Nerd Font, monospace' -t disableLeaveAlert=true sh /box/start.sh & exec nginx -c /box/nginx.conf"]
