#!/usr/bin/env bash
set -euo pipefail

tofu fmt -check -recursive infrastructure
for environment in dev prod; do
  for module in bootstrap foundation data-platform; do
    root="infrastructure/$environment/$module"
    test_directory=""
    init_args=(-backend=false -input=false)
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
