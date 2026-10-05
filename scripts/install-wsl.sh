#!/usr/bin/env bash
# Copy this starter into an empty working directory, preserving an existing .git.
set -euo pipefail
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST="${1:-/home/jukichi/workspace/my-pace}"
if [[ "$DEST" != /* ]]; then printf '絶対パスを指定してください。\n' >&2; exit 1; fi
if [[ -L "$DEST" ]]; then printf '安全のため、コピー先のシンボリックリンクには書き込みません。\n' >&2; exit 1; fi
if [[ "$SOURCE" == "$DEST" ]]; then printf '展開先とコピー先が同じです。\n' >&2; exit 1; fi
if [[ -e "$DEST" && ! -d "$DEST" ]]; then printf 'コピー先がディレクトリーではありません。\n' >&2; exit 1; fi
if [[ -d "$DEST" ]] && [[ -n "$(find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -print -quit)" ]]; then
  printf '中止: %s に既存ファイルがあります。何も上書きしていません。\n別の空フォルダーを指定するか、内容を確認してください。\n' "$DEST" >&2
  exit 1
fi
if [[ -e "$SOURCE/.git" ]]; then printf '配布元に .git があるため中止しました。\n' >&2; exit 1; fi
if [[ -f "$SOURCE/SOURCE-MANIFEST.sha256" ]]; then (cd "$SOURCE" && sha256sum -c SOURCE-MANIFEST.sha256 >/dev/null); fi
mkdir -p -- "$DEST"
cp -a -- "$SOURCE/." "$DEST/"
printf 'コピーしました: %s\n既存の .git は変更していません。\n次に: cd "%s" && npm run verify && npm start\n' "$DEST" "$DEST"
