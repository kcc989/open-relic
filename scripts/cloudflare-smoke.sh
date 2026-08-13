#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/cloudflare-smoke.sh [options]

Deploy Open Relic to a unique Cloudflare stage, exercise it with real Git
repositories, inspect runtime logs, and remove all local test clones.

Options:
  --stage NAME            Alchemy stage (default: unique timestamped stage)
  --keep-stage            Leave the Cloudflare stage deployed after the run
  --skip-check            Skip `bun run check` before deployment
  --real-repo-url URL     Larger public repository to test
  --real-repo-name NAME   Open Relic name for the larger repository
  -h, --help              Show this help

Environment:
  OPEN_RELIC_API_TOKEN    Control-plane token. A random token is generated when
                          omitted and is never printed or persisted.
  SMOKE_LOCAL_REF         Local ref to push (default: origin/main)

The Cloudflare stage is destroyed by default. The exact mktemp directory that
holds source and result clones is removed on every exit, including failures.
EOF
}

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEFAULT_STAGE="smoke_${USER:-local}_$(date -u +%Y%m%d%H%M%S)"
STAGE=$DEFAULT_STAGE
DESTROY_STAGE=1
RUN_CHECK=1
REAL_REPO_URL=https://github.com/honojs/hono.git
REAL_REPO_NAME=hono
LOCAL_REF=${SMOKE_LOCAL_REF:-origin/main}

while (($# > 0)); do
  case "$1" in
    --stage)
      STAGE=${2:?--stage requires a value}
      shift 2
      ;;
    --keep-stage)
      DESTROY_STAGE=0
      shift
      ;;
    --skip-check)
      RUN_CHECK=0
      shift
      ;;
    --real-repo-url)
      REAL_REPO_URL=${2:?--real-repo-url requires a value}
      shift 2
      ;;
    --real-repo-name)
      REAL_REPO_NAME=${2:?--real-repo-name requires a value}
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

for command in bun curl git grep jq mktemp openssl sed; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

if [[ ! -x /usr/bin/time ]]; then
  echo "Required command not found: /usr/bin/time" >&2
  exit 1
fi

TOKEN_WAS_SUPPLIED=0
if [[ -n ${OPEN_RELIC_API_TOKEN:-} ]]; then
  CONTROL_TOKEN=$OPEN_RELIC_API_TOKEN
  TOKEN_WAS_SUPPLIED=1
else
  CONTROL_TOKEN=$(openssl rand -hex 32)
fi
export OPEN_RELIC_API_TOKEN=$CONTROL_TOKEN

SMOKE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/open-relic-smoke.XXXXXX")
STAGE_DEPLOYED=0

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ -n ${SMOKE_TMP:-} && -d $SMOKE_TMP ]]; then
    local temp_name
    temp_name=$(basename "$SMOKE_TMP")
    if [[ $temp_name == open-relic-smoke.* ]]; then
      local temp_size
      temp_size=$(du -sh "$SMOKE_TMP" 2>/dev/null | awk '{print $1}')
      rm -rf -- "$SMOKE_TMP"
      echo "Removed temporary test clones: $SMOKE_TMP (${temp_size:-unknown size})"
    else
      echo "Refusing to remove unexpected temporary path: $SMOKE_TMP" >&2
      exit_code=1
    fi
  fi

  if [[ $DESTROY_STAGE -eq 1 && $STAGE_DEPLOYED -eq 1 ]]; then
    echo "Destroying Cloudflare smoke stage: $STAGE"
    if ! bun alchemy destroy --stage "$STAGE" --yes; then
      echo "Failed to destroy stage $STAGE; remove it manually." >&2
      exit_code=1
    fi
  elif [[ $STAGE_DEPLOYED -eq 1 ]]; then
    echo "Cloudflare smoke stage retained: $STAGE"
    if [[ $TOKEN_WAS_SUPPLIED -eq 0 ]]; then
      echo "Warning: its generated control-plane token was not persisted." >&2
    fi
  fi

  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

timed() {
  local label=$1
  shift
  echo
  echo "==> $label"
  /usr/bin/time -p "$@"
}

require_status() {
  local expected=$1
  local actual=$2
  local body_file=$3
  local label=$4
  if [[ $actual != "$expected" ]]; then
    echo "$label returned HTTP $actual; expected $expected" >&2
    sed -n '1,80p' "$body_file" >&2
    exit 1
  fi
}

if [[ $RUN_CHECK -eq 1 ]]; then
  bun install --frozen-lockfile
  bun run check
fi

echo
echo "==> Deploying Alchemy stage $STAGE"
bun alchemy deploy --stage "$STAGE" --yes | tee "$SMOKE_TMP/deploy.log"
STAGE_DEPLOYED=1

API_URL=$(grep -Eo 'https://[^"[:space:]]+\.workers\.dev' "$SMOKE_TMP/deploy.log" | tail -1)
if [[ -z $API_URL ]]; then
  echo "Could not read apiUrl from Alchemy output." >&2
  exit 1
fi
echo "Worker: $API_URL"

echo
echo "==> HTTP and authorization checks"
curl -sS -w '\nstatus=%{http_code} total=%{time_total}s ttfb=%{time_starttransfer}s\n' \
  "$API_URL/healthz"
echo "Warm health samples (seconds):"
for _sample in 1 2 3 4 5; do
  curl -sS -o /dev/null -w '%{time_total}\n' "$API_URL/healthz"
done

ANON_STATUS=$(curl -sS -o "$SMOKE_TMP/anonymous.json" -w '%{http_code}' \
  "$API_URL/namespaces")
require_status 401 "$ANON_STATUS" "$SMOKE_TMP/anonymous.json" "Anonymous namespace list"
jq -c . "$SMOKE_TMP/anonymous.json"

NAMESPACE="perf-$(date -u +%s)"
NS_STATUS=$(curl -sS -o "$SMOKE_TMP/namespace.json" -w '%{http_code}' \
  -X POST "$API_URL/namespaces" \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$NAMESPACE\",\"display_name\":\"Cloudflare smoke\"}")
require_status 201 "$NS_STATUS" "$SMOKE_TMP/namespace.json" "Namespace create"
jq -c . "$SMOKE_TMP/namespace.json"

echo
echo "==> Creating Open Relic test repository"
LOCAL_REPO_STATUS=$(curl -sS -o "$SMOKE_TMP/open-relic-repo.json" -w '%{http_code}' \
  -X POST "$API_URL/namespaces/$NAMESPACE/repos" \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"open-relic","description":"Cloudflare smoke test"}')
require_status 200 "$LOCAL_REPO_STATUS" "$SMOKE_TMP/open-relic-repo.json" \
  "Open Relic repository create"
LOCAL_REMOTE=$(jq -r '.result.remote' "$SMOKE_TMP/open-relic-repo.json")
LOCAL_TOKEN=$(jq -r '.result.token' "$SMOKE_TMP/open-relic-repo.json")
jq -c '.result.token="<redacted>"' "$SMOKE_TMP/open-relic-repo.json"

BAD_TOKEN_STATUS=$(curl -sS -o "$SMOKE_TMP/bad-git-token.json" -w '%{http_code}' \
  "$LOCAL_REMOTE/info/refs?service=git-upload-pack" \
  -H 'Authorization: Bearer invalid')
require_status 401 "$BAD_TOKEN_STATUS" "$SMOKE_TMP/bad-git-token.json" \
  "Invalid Git token"
jq -c . "$SMOKE_TMP/bad-git-token.json"

LOCAL_SHA=$(git rev-parse "$LOCAL_REF")
echo "Local ref: $LOCAL_REF ($LOCAL_SHA)"
echo "Commits: $(git rev-list --count "$LOCAL_REF")"
git count-objects -vH | sed -n '1,7p'

timed "Push Open Relic" \
  git -c http.extraHeader="Authorization: Bearer $LOCAL_TOKEN" \
  push "$LOCAL_REMOTE" "$LOCAL_REF:refs/heads/main"

timed "Fresh clone of Open Relic" \
  git -c http.extraHeader="Authorization: Bearer $LOCAL_TOKEN" \
  clone "$LOCAL_REMOTE" "$SMOKE_TMP/open-relic-writer"
git -C "$SMOKE_TMP/open-relic-writer" fsck --full
CLONE_SHA=$(git -C "$SMOKE_TMP/open-relic-writer" rev-parse HEAD)
if [[ $CLONE_SHA != "$LOCAL_SHA" ]]; then
  echo "Open Relic clone SHA mismatch: $CLONE_SHA != $LOCAL_SHA" >&2
  exit 1
fi

git -c http.extraHeader="Authorization: Bearer $LOCAL_TOKEN" \
  clone -q "$LOCAL_REMOTE" "$SMOKE_TMP/open-relic-reader"
git -C "$SMOKE_TMP/open-relic-writer" config user.name "Open Relic Smoke"
git -C "$SMOKE_TMP/open-relic-writer" config user.email "smoke@open-relic.invalid"
date -u +'%Y-%m-%dT%H:%M:%SZ' >"$SMOKE_TMP/open-relic-writer/deployed-smoke.txt"
git -C "$SMOKE_TMP/open-relic-writer" add deployed-smoke.txt
git -C "$SMOKE_TMP/open-relic-writer" commit -q -m "Deployed runtime smoke commit"
INCREMENTAL_SHA=$(git -C "$SMOKE_TMP/open-relic-writer" rev-parse HEAD)

timed "Incremental push" \
  git -C "$SMOKE_TMP/open-relic-writer" \
  -c http.extraHeader="Authorization: Bearer $LOCAL_TOKEN" push origin main

FETCH_FAILED=0
if ! timed "Incremental fetch" \
  git -C "$SMOKE_TMP/open-relic-reader" \
  -c http.extraHeader="Authorization: Bearer $LOCAL_TOKEN" fetch origin main; then
  FETCH_FAILED=1
  echo "Incremental fetch failed; continuing to the larger repository test." >&2
else
  FETCHED_SHA=$(git -C "$SMOKE_TMP/open-relic-reader" rev-parse FETCH_HEAD)
  if [[ $FETCHED_SHA != "$INCREMENTAL_SHA" ]]; then
    echo "Incremental fetch SHA mismatch: $FETCHED_SHA != $INCREMENTAL_SHA" >&2
    FETCH_FAILED=1
  fi
fi

echo
echo "==> Cloning larger source repository"
timed "Clone source $REAL_REPO_URL" \
  git clone --single-branch "$REAL_REPO_URL" "$SMOKE_TMP/real-source"
REAL_SHA=$(git -C "$SMOKE_TMP/real-source" rev-parse HEAD)
echo "Source SHA: $REAL_SHA"
echo "Commits: $(git -C "$SMOKE_TMP/real-source" rev-list --count HEAD)"
git -C "$SMOKE_TMP/real-source" count-objects -vH | sed -n '1,7p'

REAL_REPO_STATUS=$(curl -sS -o "$SMOKE_TMP/real-repo.json" -w '%{http_code}' \
  -X POST "$API_URL/namespaces/$NAMESPACE/repos" \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$REAL_REPO_NAME\",\"description\":\"Real repository smoke test\"}")
require_status 200 "$REAL_REPO_STATUS" "$SMOKE_TMP/real-repo.json" \
  "Larger repository create"
REAL_REMOTE=$(jq -r '.result.remote' "$SMOKE_TMP/real-repo.json")
REAL_TOKEN=$(jq -r '.result.token' "$SMOKE_TMP/real-repo.json")
jq -c '.result.token="<redacted>"' "$SMOKE_TMP/real-repo.json"

timed "Push larger repository" \
  git -C "$SMOKE_TMP/real-source" \
  -c http.extraHeader="Authorization: Bearer $REAL_TOKEN" \
  push "$REAL_REMOTE" HEAD:refs/heads/main

echo "Authenticated repository-list samples (seconds):"
for _sample in 1 2 3 4 5; do
  curl -sS -o /dev/null -w '%{time_total}\n' \
    "$API_URL/namespaces/$NAMESPACE/repos" \
    -H "Authorization: Bearer $CONTROL_TOKEN"
done

for repo_name in open-relic "$REAL_REPO_NAME"; do
  curl -sS "$API_URL/namespaces/$NAMESPACE/repos/$repo_name" \
    -H "Authorization: Bearer $CONTROL_TOKEN" \
    | jq -c '.result | {name, default_branch, last_push_at, updated_at, read_only}'
done

timed "Clone larger repository from Open Relic" \
  git -c http.extraHeader="Authorization: Bearer $REAL_TOKEN" \
  clone "$REAL_REMOTE" "$SMOKE_TMP/real-clone"
REAL_CLONE_SHA=$(git -C "$SMOKE_TMP/real-clone" rev-parse HEAD)
if [[ $REAL_CLONE_SHA != "$REAL_SHA" ]]; then
  echo "Larger repository clone SHA mismatch: $REAL_CLONE_SHA != $REAL_SHA" >&2
  exit 1
fi
timed "Verify larger repository" git -C "$SMOKE_TMP/real-clone" fsck --full
git -C "$SMOKE_TMP/real-clone" count-objects -vH | sed -n '1,7p'

echo
echo "==> Recent deployed runtime logs"
if bun alchemy logs --stage "$STAGE" --filter Api --since 1h --limit 500 \
  | tee "$SMOKE_TMP/runtime.log"; then
  grep -n 'Failed query' "$SMOKE_TMP/runtime.log" || true
else
  echo "Could not retrieve runtime logs." >&2
fi

echo
echo "Smoke test complete."
echo "Stage: $STAGE"
echo "Worker: $API_URL"
echo "Namespace: $NAMESPACE"

if [[ $FETCH_FAILED -ne 0 ]]; then
  echo "One or more incremental fetch assertions failed." >&2
  exit 1
fi
