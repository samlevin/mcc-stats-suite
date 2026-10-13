#!/usr/bin/env bash
set -euo pipefail

# Every OpenTofu pin must agree, so CI checks with the version Terrateam
# applies. Print the shared version.
pinned_version() {
  local root infrastructure terrateam
  root="$(awk '$1 == "opentofu" { print $2 }' .tool-versions)"
  infrastructure="$(awk '$1 == "opentofu" { print $2 }' infrastructure/.tool-versions)"
  terrateam="$(awk '/^engine:/ { engine = 1; next } /^[^ ]/ { engine = 0 } engine && $1 == "version:" { print $2 }' .terrateam/config.yml)"
  if [[ -z "$root" || "$root" != "$infrastructure" || "$root" != "$terrateam" ]]; then
    echo "OpenTofu pins disagree: .tool-versions=$root infrastructure/.tool-versions=$infrastructure .terrateam/config.yml=$terrateam" >&2
    return 1
  fi
  echo "$root"
}

if [[ "${1:-}" == --pinned-version ]]; then
  pinned_version
  exit
fi
pinned_version > /dev/null

# Initialize into scratch data directories so local runs never touch an
# operator's initialized roots, and enforce the committed lock files.
data_root="$(mktemp -d)"
trap 'rm -rf "$data_root"' EXIT
# Reuse provider downloads across roots and runs. CI sets its own directory.
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/opentofu/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

tofu fmt -check -recursive infrastructure
# Discover roots so a new environment root or module suite cannot pass unchecked.
# Module suites run once, through the dev root of the same name.
for root in infrastructure/*/*/; do
  root="${root%/}"
  environment="$(basename "$(dirname "$root")")"
  module="$(basename "$root")"
  [[ "$environment" == modules ]] && continue
  export TF_DATA_DIR="$data_root/$environment-$module"
  test_directory=""
  init_args=(-backend=false -input=false -lockfile=readonly)
  if [[ "$environment" == dev && -d "infrastructure/modules/$module/tests" ]]; then
    test_directory="../../modules/$module/tests"
    init_args+=(-test-directory="$test_directory")
  fi
  tofu -chdir="$root" init "${init_args[@]}"
  tofu -chdir="$root" validate
  if [[ -n "$test_directory" ]]; then
    tofu -chdir="$root" test -test-directory="$test_directory"
  fi
done

# A suite without a dev root of the same name would otherwise never run.
for tests in infrastructure/modules/*/tests; do
  [[ -d "$tests" ]] || continue
  module="$(basename "$(dirname "$tests")")"
  if [[ ! -d "infrastructure/dev/$module" ]]; then
    echo "Module tests $tests have no infrastructure/dev/$module root to run through" >&2
    exit 1
  fi
done
