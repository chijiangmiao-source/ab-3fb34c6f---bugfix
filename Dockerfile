# syntax=docker/dockerfile:1

# 依赖安装使用完整镜像（含编译工具链，better-sqlite3 无预编译包时可回退源码编译）
FROM node:20-bookworm AS deps-base
ENV npm_config_audit=false npm_config_fund=false
WORKDIR /app

FROM deps-base AS server-deps
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

FROM deps-base AS devices-deps
COPY devices/package.json devices/package-lock.json ./devices/
RUN cd devices && npm ci --omit=dev

FROM deps-base AS web-build
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# ---------- 运行时：发布页 + 接口 ----------
FROM node:20-bookworm-slim AS app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist
WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=web-build /app/web/dist ./web/dist
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=5s --timeout=3s --retries=12 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]

# ---------- 运行时：设备模拟器 ----------
FROM node:20-bookworm-slim AS devices
ENV NODE_ENV=production \
    PORT=9000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=devices-deps /app/devices/node_modules ./devices/node_modules
COPY devices/package.json ./devices/package.json
COPY devices/src ./devices/src
EXPOSE 9000
VOLUME ["/data"]
HEALTHCHECK --interval=5s --timeout=3s --retries=12 --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "devices/src/index.js"]

# ---------- 验证：代码测试 + 构建检查 + API 冒烟 ----------
FROM deps-base AS verify
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY server ./server
COPY devices/package.json devices/package-lock.json ./devices/
RUN cd devices && npm ci
COPY devices ./devices
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
COPY verify ./verify
ENV API_BASE=http://app:8080 \
    SIMULATOR_URL=http://devices:9000
CMD ["sh", "verify/run.sh"]
