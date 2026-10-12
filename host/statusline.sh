#!/bin/sh
# Claude Code's statusLine command (~/.claude/settings.json), run with the session's JSON on
# stdin. Draws nothing. When the JSON holds `seven_day` it copies it to ccx-usage.json,
# through a temp file and a `mv` so a reader never sees half of one, and appends
# `<epoch s> <7d %> <7d resets_at> <5h %> <5h resets_at>` to ccx-usage.log when either
# figure is ahead of the log's last line: a later resets_at, or the same one and a higher %.
# Every instance runs it and one idle since an older response holds older numbers, which
# put back would add a line on every alternation.
s=$(cat)
case $s in *'"seven_day"'*) ;; *) exit 0;; esac
d=~/.claude
printf '%s' "$s" > "$d/ccx-usage.json.$$" && command mv -f "$d/ccx-usage.json.$$" "$d/ccx-usage.json"
pick() {
  printf '%s' "$s" |
    sed -n "s/.*\"$1\":{\"used_percentage\":\([0-9.]*\),\"resets_at\":\([0-9]*\)}.*/\1 \2/p"
}
v="$(pick seven_day) $(pick five_hour)"
h=$d/ccx-usage.log
echo "$(tail -n 1 "$h" 2>/dev/null) - $v" | awk '
  function ahead(u, r, lu, lr) { return r != "" && (r + 0 > lr + 0 || (r == lr && u + 0 > lu + 0)) }
  { n = split($0, f, " - "); split(f[1], l, " "); split(f[2], c, " ")
    exit !(l[1] == "" || ahead(c[1], c[2], l[2], l[3]) || ahead(c[3], c[4], l[4], l[5])) }' ||
  exit 0
now=$(date +%s)
echo "$now $v" >> "$h"
# trimmed to 22 days once the oldest line is 23 days old, so not on every append: last
# week's whole log stays for ccx burn
first=$(head -n 1 "$h" | cut -d' ' -f1)
[ $((now - ${first:-$now})) -gt 1987200 ] || exit 0
awk -v c=$((now - 1900800)) '$1 >= c' "$h" > "$h.$$" && command mv -f "$h.$$" "$h"
