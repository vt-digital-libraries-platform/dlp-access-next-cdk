#!/usr/bin/env bash
# Elastic Beanstalk's Node.js platform only runs `npm install --production`
# for us; it never runs a build step. Next.js needs its devDependencies
# (typescript, tailwind, etc.) to compile, so install everything and build
# here before the platform's own install/start steps run.
set -euo pipefail

cd /var/app/staging

npm ci
npm run build
