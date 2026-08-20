# 同一镜像三个命令：api / worker / migrate（见 docker/entrypoint.sh）
FROM node:22-bookworm-slim AS base
# npm / pnpm 的源。默认官方源，不写死镜像源——换了对国外网络反而更慢。
# 国内网络差就在 .env 里设 NPM_REGISTRY=https://registry.npmmirror.com（compose 会传进来），
# 或者 docker build --build-arg NPM_REGISTRY=...。实测过一台国内 NAS：
# 官方源 88 KB/s、npmmirror 5.5 MB/s，差 64 倍，不换根本装不完。
ARG NPM_REGISTRY=https://registry.npmjs.org
# COREPACK_NPM_REGISTRY 也要给：corepack 自己去下 pnpm，不设的话它仍走官方源。
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    npm_config_registry=$NPM_REGISTRY \
    COREPACK_NPM_REGISTRY=$NPM_REGISTRY
RUN corepack enable
WORKDIR /app

# 只有清单和锁文件的一层，装依赖的两条路（全量 / 仅生产）都从这里分叉，
# 这样改源码不会让依赖层失效。argon2 是原生依赖，装的时候要编译工具链。
FROM base AS manifests
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/

FROM manifests AS deps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @kb/web build

# 生产依赖单独装一遍：从只有清单的那层出发，装出来的 node_modules 里
# 压根没有 eslint / typescript / vite / playwright-core 这些东西，
# 而不是装完再摘（摘只去掉链接，包本体还留在 .pnpm 里）。
# tsx 是**运行时**依赖——entrypoint 直接用它跑 .ts 源码，所以它在 dependencies 里。
# CI=true：pnpm 要重建 node_modules，没有 TTY 时不加这个会停下来等人确认。
FROM manifests AS prod-deps
RUN CI=true pnpm install --prod --frozen-lockfile

# 运行时：源码用 tsx 直接跑（packages 的 exports 指向 .ts 源文件，不产出 JS 构建物）
FROM base AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist
COPY --from=prod-deps --chown=node:node /app /app
COPY --chown=node:node . /app
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||12099)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["api"]
