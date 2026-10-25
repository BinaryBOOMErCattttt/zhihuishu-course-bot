#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f config.json ] || { echo "Copy config.example.json to config.json and fill studyUrl first."; exit 1; }
exec node server.js
