#!/bin/sh
# verify 服务入口：代码测试 → 构建检查 → API 冒烟 → 中断恢复端到端，任一失败即非零退出
set -e

echo "=== [1/4] 代码测试：服务端单元测试 ==="
cd /app/server
npm test

echo ""
echo "=== [2/4] 构建检查：前端生产构建 + 服务端可启动性 ==="
cd /app/web
npm run build
node --input-type=module -e "await import('/app/server/src/app.js'); await import('/app/server/src/service.js'); console.log('server 模块加载 OK')"

echo ""
echo "=== [3/4] API 冒烟：回执补记与重复发布复核 ==="
node /app/verify/smoke.mjs

echo ""
echo "=== [4/4] 中断恢复端到端：最终切换前后杀死进程并重启核对 ==="
node /app/verify/restart-e2e.mjs

echo ""
echo "=== VERIFY 全部通过 ==="
