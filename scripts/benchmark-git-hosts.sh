#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/benchmark-git-hosts.sh --repo-url URL [options]

Benchmark one GitHub repository against disposable repositories on GitHub,
Cloudflare Artifacts, and a deployed Open Relic installation. Results are
written as TSV on stdout; progress and cleanup messages go to stderr.

Options:
  --repo-url URL          Public GitHub repository to copy (required)
  --label NAME            Short result label (default: repository basename)
  --expected-sha SHA      Fail if the source default branch has moved
  --hosts LIST            Comma-separated hosts in run order
                          (default: github,artifacts,open-relic)
  --artifacts-namespace N Hosted Artifacts namespace (default: default)
  --keep-remotes          Keep disposable remote resources for investigation
  -h, --help              Show this help

Environment for GitHub:
  An authenticated `gh` CLI session whose token can create and delete private
  repositories for the authenticated user.

Environment for Cloudflare Artifacts:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN

Environment for Open Relic:
  OPEN_RELIC_URL          Deployed Worker base URL
  OPEN_RELIC_API_TOKEN    Installation API token

The script always removes its temporary local clones. Remote resources are
also removed on exit unless --keep-remotes is supplied.
EOF
}

REPO_URL=
LABEL=
EXPECTED_SHA=
HOSTS=github,artifacts,open-relic
ARTIFACTS_NAMESPACE=default
KEEP_REMOTES=0

while (($# > 0)); do
  case "$1" in
    --repo-url)
      REPO_URL=${2:?--repo-url requires a value}
      shift 2
      ;;
    --label)
      LABEL=${2:?--label requires a value}
      shift 2
      ;;
    --expected-sha)
      EXPECTED_SHA=${2:?--expected-sha requires a value}
      shift 2
      ;;
    --hosts)
      HOSTS=${2:?--hosts requires a value}
      shift 2
      ;;
    --artifacts-namespace)
      ARTIFACTS_NAMESPACE=${2:?--artifacts-namespace requires a value}
      shift 2
      ;;
    --keep-remotes)
      KEEP_REMOTES=1
      shift
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

if [[ -z $REPO_URL ]]; then
  echo "--repo-url is required" >&2
  usage >&2
  exit 2
fi

for command in awk cp curl cut git jq mktemp sed tr; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done
if [[ ! -x /usr/bin/time ]]; then
  echo "Required command not found: /usr/bin/time" >&2
  exit 1
fi

if [[ -z $LABEL ]]; then
  LABEL=$(basename "${REPO_URL%.git}")
fi
SAFE_LABEL=$(printf '%s' "$LABEL" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | cut -c1-8)
if [[ -z $SAFE_LABEL ]]; then
  SAFE_LABEL=repo
fi

RUN_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_TAG=$(date -u +%Y%m%d%H%M%S)-$$
BENCH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/open-relic-host-bench.XXXXXX")
SOURCE_DIR="$BENCH_TMP/source"
GITHUB_OWNER=
GITHUB_REPO_CREATED=
ARTIFACTS_REPO_CREATED=
OPEN_RELIC_NAMESPACE_CREATED=
ARTIFACTS_BASE=

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ $KEEP_REMOTES -eq 0 ]]; then
    if [[ -n $GITHUB_REPO_CREATED && -n $GITHUB_OWNER ]]; then
      if ! gh api -X DELETE "repos/$GITHUB_OWNER/$GITHUB_REPO_CREATED" >/dev/null; then
        echo "GitHub cleanup failed: $GITHUB_OWNER/$GITHUB_REPO_CREATED" >&2
        exit_code=1
      fi
    fi

    if [[ -n $ARTIFACTS_REPO_CREATED && -n $ARTIFACTS_BASE ]]; then
      local artifacts_delete_status
      artifacts_delete_status=$(curl -sS -o /dev/null -w '%{http_code}' \
        -X DELETE "$ARTIFACTS_BASE/repos/$ARTIFACTS_REPO_CREATED" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN") \
        || artifacts_delete_status=000
      case "$artifacts_delete_status" in
        200 | 202 | 204) ;;
        *)
          echo "Artifacts cleanup failed with HTTP $artifacts_delete_status: $ARTIFACTS_REPO_CREATED" >&2
          exit_code=1
          ;;
      esac
    fi

    if [[ -n $OPEN_RELIC_NAMESPACE_CREATED ]]; then
      local open_relic_delete_status
      open_relic_delete_status=$(curl -sS -o /dev/null -w '%{http_code}' \
        -X DELETE "${OPEN_RELIC_URL%/}/namespaces/$OPEN_RELIC_NAMESPACE_CREATED" \
        -H "Authorization: Bearer $OPEN_RELIC_API_TOKEN") \
        || open_relic_delete_status=000
      case "$open_relic_delete_status" in
        200 | 202 | 204) ;;
        *)
          echo "Open Relic cleanup failed with HTTP $open_relic_delete_status: $OPEN_RELIC_NAMESPACE_CREATED" >&2
          exit_code=1
          ;;
      esac
    fi
  else
    [[ -z $GITHUB_REPO_CREATED ]] || echo "Kept GitHub repository: $GITHUB_OWNER/$GITHUB_REPO_CREATED" >&2
    [[ -z $ARTIFACTS_REPO_CREATED ]] || echo "Kept Artifacts repository: $ARTIFACTS_NAMESPACE/$ARTIFACTS_REPO_CREATED" >&2
    [[ -z $OPEN_RELIC_NAMESPACE_CREATED ]] || echo "Kept Open Relic namespace: $OPEN_RELIC_NAMESPACE_CREATED" >&2
  fi

  unset BENCH_GITHUB_TOKEN GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0

  if [[ -n ${BENCH_TMP:-} && -d $BENCH_TMP ]]; then
    local temp_name
    temp_name=$(basename "$BENCH_TMP")
    if [[ $temp_name == open-relic-host-bench.* ]]; then
      rm -rf -- "$BENCH_TMP"
      echo "Removed temporary benchmark directory: $BENCH_TMP" >&2
    else
      echo "Refusing to remove unexpected benchmark path: $BENCH_TMP" >&2
      exit_code=1
    fi
  fi

  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

MEASURED_SECONDS=
measure() {
  local label=$1
  shift
  local stdout_file="$BENCH_TMP/$label.stdout"
  local time_file="$BENCH_TMP/$label.time"

  echo "==> $label" >&2
  if ! /usr/bin/time -p "$@" >"$stdout_file" 2>"$time_file"; then
    sed -n '1,100p' "$stdout_file" >&2
    sed -n '1,100p' "$time_file" >&2
    return 1
  fi
  MEASURED_SECONDS=$(awk '$1 == "real" { print $2 }' "$time_file" | tail -1)
  if [[ -z $MEASURED_SECONDS ]]; then
    echo "No elapsed time found for $label" >&2
    return 1
  fi
}

require_create_status() {
  local status=$1
  local body_file=$2
  local label=$3
  case "$status" in
    200 | 201) ;;
    *)
      echo "$label failed with HTTP $status" >&2
      jq . "$body_file" >&2 || sed -n '1,100p' "$body_file" >&2
      return 1
      ;;
  esac
}

host_requested() {
  case ",$HOSTS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

IFS=',' read -r -a HOST_LIST <<<"$HOSTS"
for host in "${HOST_LIST[@]}"; do
  case "$host" in
    github | artifacts | open-relic) ;;
    *)
      echo "Unsupported host in --hosts: $host" >&2
      exit 2
      ;;
  esac
done

if host_requested artifacts; then
  : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required for Artifacts}"
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required for Artifacts}"
  ARTIFACTS_BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces/$ARTIFACTS_NAMESPACE"
fi
if host_requested open-relic; then
  : "${OPEN_RELIC_URL:?OPEN_RELIC_URL is required for Open Relic}"
  : "${OPEN_RELIC_API_TOKEN:?OPEN_RELIC_API_TOKEN is required for Open Relic}"
fi
if host_requested github; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "Required command not found: gh" >&2
    exit 1
  fi
  gh auth status >/dev/null
  GITHUB_OWNER=$(gh api user --jq .login)
  BENCH_GITHUB_TOKEN=$(gh auth token)
  export BENCH_GITHUB_TOKEN
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=credential.helper
  export GIT_CONFIG_VALUE_0='!f() { printf "username=x-access-token\npassword=%s\n" "$BENCH_GITHUB_TOKEN"; }; f'
fi

echo "==> Clone source $REPO_URL" >&2
git clone --single-branch -q "$REPO_URL" "$SOURCE_DIR"
SOURCE_SHA=$(git -C "$SOURCE_DIR" rev-parse HEAD)
if [[ -n $EXPECTED_SHA && $SOURCE_SHA != "$EXPECTED_SHA" ]]; then
  echo "Source moved: $SOURCE_SHA != $EXPECTED_SHA" >&2
  exit 1
fi
SOURCE_COMMITS=$(git -C "$SOURCE_DIR" rev-list --count HEAD)
SOURCE_OBJECTS=$(git -C "$SOURCE_DIR" count-objects -v | awk '$1 == "in-pack:" { print $2 }')
SOURCE_PACK_KIB=$(git -C "$SOURCE_DIR" count-objects -v | awk '$1 == "size-pack:" { print $2 }')
SOURCE_PACK_MIB=$(awk -v kib="$SOURCE_PACK_KIB" 'BEGIN { printf "%.2f", kib / 1024 }')

REMOTE_URL=
REMOTE_TOKEN=
create_github_repository() {
  GITHUB_REPO_CREATED="open-relic-bench-$SAFE_LABEL-$RUN_TAG"
  gh api -X POST user/repos \
    -f name="$GITHUB_REPO_CREATED" \
    -F private=true \
    -f description='Disposable Open Relic Git-host benchmark' >/dev/null
  REMOTE_URL="https://github.com/$GITHUB_OWNER/$GITHUB_REPO_CREATED.git"
  REMOTE_TOKEN=
}

create_artifacts_repository() {
  ARTIFACTS_REPO_CREATED="bench-$SAFE_LABEL-$RUN_TAG"
  local body_file="$BENCH_TMP/artifacts-create.json"
  local payload_file="$BENCH_TMP/artifacts-create-payload.json"
  jq -nc --arg name "$ARTIFACTS_REPO_CREATED" \
    '{name: $name, description: "Disposable Open Relic Git-host benchmark"}' \
    >"$payload_file"
  local status
  status=$(curl -sS -o "$body_file" -w '%{http_code}' \
    -X POST "$ARTIFACTS_BASE/repos" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "@$payload_file")
  require_create_status "$status" "$body_file" "Artifacts repository create"
  REMOTE_URL=$(jq -er '.result.remote' "$body_file")
  REMOTE_TOKEN=$(jq -er '.result.token' "$body_file")
}

wait_for_open_relic() {
  local attempt status
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    status=$(curl -sS -o /dev/null -w '%{http_code}' \
      "${OPEN_RELIC_URL%/}/healthz") || status=000
    if [[ $status == 200 ]]; then
      return 0
    fi
    echo "Open Relic is not ready (HTTP $status, attempt $attempt/12)" >&2
    sleep 5
  done
  echo "Open Relic did not become ready within 60 seconds" >&2
  return 1
}

create_open_relic_repository() {
  wait_for_open_relic
  OPEN_RELIC_NAMESPACE_CREATED="bench-$SAFE_LABEL-$RUN_TAG"
  local namespace_body="$BENCH_TMP/open-relic-namespace.json"
  local namespace_payload="$BENCH_TMP/open-relic-namespace-payload.json"
  jq -nc --arg slug "$OPEN_RELIC_NAMESPACE_CREATED" \
    '{slug: $slug, display_name: "Git-host benchmark"}' >"$namespace_payload"
  local status
  status=$(curl -sS -o "$namespace_body" -w '%{http_code}' \
    -X POST "${OPEN_RELIC_URL%/}/namespaces" \
    -H "Authorization: Bearer $OPEN_RELIC_API_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "@$namespace_payload")
  require_create_status "$status" "$namespace_body" "Open Relic namespace create"

  local repository_body="$BENCH_TMP/open-relic-create.json"
  status=$(curl -sS -o "$repository_body" -w '%{http_code}' \
    -X POST "${OPEN_RELIC_URL%/}/namespaces/$OPEN_RELIC_NAMESPACE_CREATED/repos" \
    -H "Authorization: Bearer $OPEN_RELIC_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"name":"source","description":"Disposable Git-host benchmark"}')
  require_create_status "$status" "$repository_body" "Open Relic repository create"
  REMOTE_URL=$(jq -er '.result.remote' "$repository_body")
  REMOTE_TOKEN=$(jq -er '.result.token' "$repository_body")
}

benchmark_remote() {
  local host=$1
  local clone_dir="$BENCH_TMP/$host-clone"
  local reader_dir="$BENCH_TMP/$host-reader"

  if [[ -n $REMOTE_TOKEN ]]; then
    measure "$host-initial-push" \
      git -C "$SOURCE_DIR" \
      -c "http.extraHeader=Authorization: Bearer $REMOTE_TOKEN" \
      push -q "$REMOTE_URL" HEAD:refs/heads/main
  else
    measure "$host-initial-push" \
      git -C "$SOURCE_DIR" push -q "$REMOTE_URL" HEAD:refs/heads/main
  fi
  local initial_push_seconds=$MEASURED_SECONDS

  if [[ $host == github ]]; then
    gh api -X PATCH "repos/$GITHUB_OWNER/$GITHUB_REPO_CREATED" \
      -f default_branch=main >/dev/null
  fi

  if [[ -n $REMOTE_TOKEN ]]; then
    measure "$host-fresh-clone" \
      git -c "http.extraHeader=Authorization: Bearer $REMOTE_TOKEN" \
      clone -q "$REMOTE_URL" "$clone_dir"
  else
    measure "$host-fresh-clone" git clone -q "$REMOTE_URL" "$clone_dir"
  fi
  local fresh_clone_seconds=$MEASURED_SECONDS
  local clone_sha
  clone_sha=$(git -C "$clone_dir" rev-parse HEAD)
  if [[ $clone_sha != "$SOURCE_SHA" ]]; then
    echo "$host clone SHA mismatch: $clone_sha != $SOURCE_SHA" >&2
    return 1
  fi

  measure "$host-fsck" git -C "$clone_dir" fsck --full --no-progress
  local fsck_seconds=$MEASURED_SECONDS
  local clone_pack_kib clone_pack_mib
  clone_pack_kib=$(git -C "$clone_dir" count-objects -v | awk '$1 == "size-pack:" { print $2 }')
  clone_pack_mib=$(awk -v kib="$clone_pack_kib" 'BEGIN { printf "%.2f", kib / 1024 }')

  cp -R "$clone_dir" "$reader_dir"
  git -C "$clone_dir" config user.name "Open Relic Benchmark"
  git -C "$clone_dir" config user.email "benchmark@open-relic.invalid"
  local marker=".open-relic-benchmark-$RUN_TAG.txt"
  printf 'source=%s\nhost=%s\nrun=%s\n' "$SOURCE_SHA" "$host" "$RUN_UTC" \
    >"$clone_dir/$marker"
  git -C "$clone_dir" add -f "$marker"
  git -C "$clone_dir" commit -q -m "Open Relic incremental benchmark"
  local incremental_sha
  incremental_sha=$(git -C "$clone_dir" rev-parse HEAD)

  if [[ -n $REMOTE_TOKEN ]]; then
    measure "$host-incremental-push" \
      git -C "$clone_dir" \
      -c "http.extraHeader=Authorization: Bearer $REMOTE_TOKEN" \
      push -q origin main
  else
    measure "$host-incremental-push" \
      git -C "$clone_dir" push -q origin main
  fi
  local incremental_push_seconds=$MEASURED_SECONDS
  if [[ -n $REMOTE_TOKEN ]]; then
    measure "$host-incremental-fetch" \
      git -C "$reader_dir" \
      -c "http.extraHeader=Authorization: Bearer $REMOTE_TOKEN" \
      fetch -q origin main
  else
    measure "$host-incremental-fetch" \
      git -C "$reader_dir" fetch -q origin main
  fi
  local incremental_fetch_seconds=$MEASURED_SECONDS
  local fetched_sha
  fetched_sha=$(git -C "$reader_dir" rev-parse FETCH_HEAD)
  if [[ $fetched_sha != "$incremental_sha" ]]; then
    echo "$host incremental SHA mismatch: $fetched_sha != $incremental_sha" >&2
    return 1
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$RUN_UTC" "$LABEL" "$host" "$SOURCE_SHA" "$SOURCE_COMMITS" \
    "$SOURCE_OBJECTS" "$SOURCE_PACK_MIB" "$initial_push_seconds" \
    "$fresh_clone_seconds" "$fsck_seconds" "$clone_pack_mib" pass \
    "$incremental_push_seconds" "$incremental_fetch_seconds"
}

printf 'run_utc\trepo\thost\tsource_sha\tcommits\tobjects\tsource_pack_mib\tinitial_push_s\tfresh_clone_s\tfsck_s\tclone_pack_mib\tsha_integrity\tincremental_push_s\tincremental_fetch_s\n'

for host in "${HOST_LIST[@]}"; do
  REMOTE_URL=
  REMOTE_TOKEN=
  case "$host" in
    github) create_github_repository ;;
    artifacts) create_artifacts_repository ;;
    open-relic) create_open_relic_repository ;;
  esac
  benchmark_remote "$host"
done
