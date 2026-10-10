#!/usr/bin/env bash
set -euo pipefail

tofu fmt -check -recursive infrastructure
for environment in dev prod; do
  for module in bootstrap foundation data-platform; do
    root="infrastructure/$environment/$module"
    test_directory=""
    if [[ "$environment" == dev && ( "$module" == bootstrap || "$module" == foundation ) ]]; then
      test_directory="../../modules/$module/tests"
      tofu -chdir="$root" init -backend=false -input=false -test-directory="$test_directory"
    else
      tofu -chdir="$root" init -backend=false -input=false
    fi
    tofu -chdir="$root" validate
    if [[ -n "$test_directory" ]]; then
      tofu -chdir="$root" test -test-directory="$test_directory"
    fi
  done
done
