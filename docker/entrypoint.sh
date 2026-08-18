#!/bin/sh
set -eu
cd /app
case "${1:-api}" in
  api)     exec /app/apps/api/node_modules/.bin/tsx    /app/apps/api/src/index.ts ;;
  worker)  exec /app/apps/worker/node_modules/.bin/tsx /app/apps/worker/src/index.ts ;;
  migrate) exec /app/apps/api/node_modules/.bin/tsx    /app/apps/api/src/db/push.ts ;;
  *)       exec "$@" ;;
esac
