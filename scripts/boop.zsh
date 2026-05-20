# boop - resume the most recent coding session that boop spawned.
#
# Install: source this file from your ~/.zshrc, e.g.
#   source ~/Programming/boop-agent/scripts/boop.zsh
#
# Usage: `boop` opens an fzf picker of the last 5 projects (one per project,
# newest first). Enter resumes the top one.
#
# Requires: fzf (`brew install fzf`).

boop() {
  local hist=~/.boop/history
  [[ -s $hist ]] || { echo "no boop sessions yet"; return 1; }
  command -v fzf >/dev/null || { echo "install fzf: brew install fzf"; return 1; }
  local pick
  pick=$(awk -F'\t' '{ key=$4 ":" $2; a[key]=$0 } END { for (k in a) print a[k] }' "$hist" \
    | sort -rn -t$'\t' -k1,1 \
    | head -5 \
    | awk -F'\t' -v now="$(date +%s)" -v home="$HOME" '{
        d = now - int($1/1000)
        if (d < 60) ago = d "s"
        else if (d < 3600) ago = int(d/60) "m"
        else if (d < 86400) ago = int(d/3600) "h"
        else ago = int(d/86400) "d"
        pretty = $2
        if (substr(pretty, 1, length(home)) == home) pretty = "~" substr(pretty, length(home)+1)
        agent = $4 ? $4 : "claude"
        printf "%-8s %-40s %4s ago\t%s\t%s\t%s\n", agent, pretty, ago, $2, $3, agent
      }' \
    | fzf --delimiter=$'\t' --with-nth=1 --height=40% --reverse --no-info \
          --prompt="boop > ") || return

  local dir sid agent
  dir=$(cut -f2 <<< "$pick")
  sid=$(cut -f3 <<< "$pick")
  agent=$(cut -f4 <<< "$pick")
  if [[ "$agent" == "codex" ]]; then
    command -v codex >/dev/null || { echo "codex CLI not found in PATH"; return 1; }
    cd "$dir" && codex exec resume "$sid"
  else
    command -v claude >/dev/null || { echo "claude CLI not found in PATH"; return 1; }
    local remote_name="boop-${${dir:t}//[^a-zA-Z0-9_-]/-}"
    cd "$dir" && claude --resume "$sid" --remote-control "$remote_name"
  fi
}
