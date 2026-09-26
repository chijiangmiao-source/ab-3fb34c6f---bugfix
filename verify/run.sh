#!/bin/sh
# verify 服务入口：代码测试 → 构建检查 → API 冒烟，任一失败即非零退出
set -e

echo "=== [1/3] 代码测试：服务端单元测试 ==="
cd /app/server
npm test

echo ""
echo "=== [2/3] 构建检查：前端生产构建 + 服务端可启动性 ==="
cd /app/web
npm run build
node --input-type=module -e "await import('/app/server/src/app.js'); await import('/app/server/src/service.js'); console.log('server 模块加载 OK')"

echo ""
echo "=== [3/3] API 冒烟：回执补记与重复发布复核 ==="
node /app/verify/smoke.mjs

echo ""
echo "=== VERIFY 全部通过 ==="
