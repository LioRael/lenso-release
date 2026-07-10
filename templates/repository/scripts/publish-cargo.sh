#!/bin/sh
set -eu
: "${CARGO_REGISTRY_TOKEN:?official crates.io token action did not provide a token}"
test -z "${CARGO_TOKEN:-}" || { echo 'CARGO_TOKEN fallback is forbidden' >&2; exit 1; }
exec node .lenso-release/runtime/lib/repository/cli.js publish
