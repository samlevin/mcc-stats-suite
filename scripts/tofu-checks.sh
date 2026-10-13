#!/usr/bin/env bash
set -euo pipefail

# Initialize into scratch data directories so local runs never touch an
# operator's initialized roots, and enforce the committed lock files.
data_root="$(mktemp -d)"
trap 'rm -rf "$data_root"' EXIT
# Reuse provider downloads across roots and runs. CI sets its own directory.
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/opentofu/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

tofu fmt -check -recursive infrastructure
for environment in dev prod; do
  for module in bootstrap foundation data-platform; do
    root="infrastructure/$environment/$module"
    export TF_DATA_DIR="$data_root/$environment-$module"
    test_directory=""
    init_args=(-backend=false -input=false -lockfile=readonly)
    if [[ "$environment" == dev && ( "$module" == bootstrap || "$module" == foundation ) ]]; then
      test_directory="../../modules/$module/tests"
      init_args+=(-test-directory="$test_directory")
    fi
    tofu -chdir="$root" init "${init_args[@]}"
    tofu -chdir="$root" validate
    if [[ -n "$test_directory" ]]; then
      tofu -chdir="$root" test -test-directory="$test_directory"
    fi
  done
done
