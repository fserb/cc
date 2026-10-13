#!/bin/sh
# PreToolUse hook on AskUserQuestion: keeps the tool's input, the questions as written, in
# ~/.claude/ccx-ask/<session_id>.json for cchost to show. Claude Code writes the tool_use to
# the transcript only once the question is answered (2.1.296), and the pane holds what fits
# on its screen, so this is the one place the whole question is while the dialog is up.
# Prints nothing, so it decides nothing.
dir="$HOME/.claude/ccx-ask"
input=$(cat)
id=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\([0-9a-f-]*\)".*/\1/p' | head -n 1)
[ -n "$id" ] || exit 0
mkdir -p "$dir"
printf '%s' "$input" > "$dir/$id.tmp" && mv "$dir/$id.tmp" "$dir/$id.json"
find "$dir" -name '*.json' -mtime +2 -delete 2>/dev/null
exit 0
