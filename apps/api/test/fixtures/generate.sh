#!/usr/bin/env bash
#
# Regenerates the packs in this directory with the local `git`, so the pack
# reader is checked against what a real Git client emits rather than against
# our own writer. Run it from anywhere; it works in a temporary repository.
#
#   apps/api/test/fixtures/generate.sh
#
# The repository is built with fixed identities and dates, so the object ids
# are stable and a regeneration that changes them is a signal, not noise.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME="Open Relic"
export GIT_AUTHOR_EMAIL="fixtures@open-relic.dev"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00+0000"
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"

cd "$work"
git init --quiet --initial-branch=main .

# Larger than the 1.5 MiB chunk the object store splits at, and repetitive
# enough that the pack stays small enough to commit.
seq 1 40000 |
  awk '{ printf "line %06d the quick brown fox jumps over the lazy dog\n", $1 }' \
    >big.txt
seq 1 800 |
  awk '{ printf "note %04d something worth saying about the anvil firmware\n", $1 }' \
    >notes.md

git add .
git commit --quiet -m "Add the notes and the big file"

# Small edits across many commits are what give the packer chains to build:
# each revision of the notes deltas against the one before it.
for revision in 1 2 3 4 5 6; do
  perl -pi -e "s/^note 0${revision}00 .*/note 0${revision}00 revised in ${revision}/" notes.md
  git commit --quiet -am "Revise note 0${revision}00"
done

perl -pi -e 's/^line 020000 .*/line 020000 revised/' big.txt
git commit --quiet -am "Revise the big file"

git tag -a v1 -m "The first tag"

# Every object in the repository, so the manifest and the packs cannot disagree.
names="$work/names.txt"
git cat-file --batch-all-objects --batch-check='%(objectname)' | sort >"$names"

# `--delta-base-offset` is what makes the packer reach for ofs-delta; without
# it, deltas name their base by object id. A real client sends either.
git pack-objects --stdout --window=50 --depth=10 --delta-base-offset \
  <"$names" >"$here/real-git-ofs-delta.pack"
git pack-objects --stdout --window=50 --depth=10 \
  <"$names" >"$here/real-git-ref-delta.pack"

git cat-file --batch-all-objects \
  --batch-check='%(objectname) %(objecttype) %(objectsize)' |
  sort |
  awk '
    BEGIN { print "["; separator = "" }
    {
      printf "%s  { \"oid\": \"%s\", \"type\": \"%s\", \"size\": %s }", separator, $1, $2, $3
      separator = ",\n"
    }
    END { print "\n]" }
  ' >"$here/real-git-objects.json"

echo "Wrote $(wc -l <"$names" | tr -d ' ') objects to $here"
