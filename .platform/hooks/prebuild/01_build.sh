#!/usr/bin/env bash
# Run build before eb runs install
set -euo pipefail

cd /var/app/staging

npm ci
npm run build
