#!/bin/sh
# 只为新安装生成独立配置；不会读取或覆盖真实 .env，也不会删除已有卷。
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
usage() { printf '%s\n' '用法: sh scripts/home-setup.sh notes.example.com [--start]' '      sh scripts/home-setup.sh --local [--start]' '默认只生成 .env.home；--start 明确启动 Docker。域名模式需 DNS 和 80/443 已就绪。'; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { usage; exit 1; }
MODE=$1
START=${2:-}
[ -z "$START" ] || [ "$START" = '--start' ] || { usage; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo '缺少 openssl，请先通过系统包管理器安装。' >&2; exit 1; }
if [ "$MODE" = '--local' ]; then
  DOMAIN=localhost
  URL=http://localhost:12099
else
  case "$MODE" in *[!a-zA-Z0-9.-]*|.*|*.|*..*|-*|*-) echo '请输入纯域名，不要协议、端口、路径或空格。' >&2; exit 1;; esac
  [ "${#MODE}" -le 253 ] && printf '%s' "$MODE" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' || { echo '请输入有效域名；本机试用请选择 --local。' >&2; exit 1; }
  DOMAIN=$MODE
  URL=https://$DOMAIN
fi
[ ! -e "$ROOT/.env.home" ] || { echo '.env.home 已存在，未修改。请使用现有配置启动；不要重新生成 APP_SECRET 或数据库密码。' >&2; exit 1; }
SECRET=$(openssl rand -hex 48)
PASSWORD=$(openssl rand -hex 32)
umask 077
# noclobber 避免检查后另一会话刚建好的配置被覆盖。
(set -C; cat > "$ROOT/.env.home" <<CONFIG
APP_SECRET=$SECRET
PUBLIC_URL=$URL
KB_DOMAIN=$DOMAIN
KB_LOCAL_PORT=12099
POSTGRES_USER=xingli
POSTGRES_PASSWORD=$PASSWORD
POSTGRES_DB=xingli
DATA_DIR=/data
CONFIG
)
printf '%s\n' '已创建权限 600 的 .env.home（密钥未显示）。请离线安全保存该文件。'
if [ "$MODE" = '--local' ]; then
  echo '启动: docker compose --env-file .env.home -f compose.home.yml up -d --build'
else
  echo '启动: docker compose --env-file .env.home -f compose.home.yml --profile tls up -d --build'
fi
printf '入口: %s\n' "$URL"
if [ "$START" = '--start' ]; then
  command -v docker >/dev/null 2>&1 || { echo '缺少 Docker，配置已保留。安装 Docker Engine 与 Compose v2 后执行上面的启动命令。' >&2; exit 1; }
  cd "$ROOT"
  if [ "$MODE" = '--local' ]; then docker compose --env-file .env.home -f compose.home.yml up -d --build
  else docker compose --env-file .env.home -f compose.home.yml --profile tls up -d --build; fi
fi
