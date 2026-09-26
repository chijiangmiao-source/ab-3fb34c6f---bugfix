# 低温光学台参数发布系统

工程师在网页提交**稳定发布标识、目标采集器与参数文本**并取得**发布编号**；服务端先把同一份参数摘要幂等暂存到全部目标采集器，收齐回执后原子指派**生效代次**，再逐台执行最终切换——**只有全部目标采集器确认实际生效的发布编号、摘要、代次均一致，发布才显示“已发布”**。页面重试、进程中断、设备迟到都不会造成“页面声称已发布而设备内容不一致”。

## 架构

```
┌────────────┐   HTTP    ┌───────────────────────────┐   HTTP   ┌────────────────.──┐
│ React 发布页 │ ───────▶ │ app（接口 + 静态页）        │ ──────▶ │ devices 模拟器  │
│ (web/dist) │ ◀─────── │  SQLite: releases/receipts │ ◀────── │  SQLite: stages │
└────────────┘  只读已确认 │  generations/activations │  幂等暂存 │  active_versions │
              └───────────────────────────┘  幂等切换 │  （独立持久化卷） │
                                                    └────────────────┘
```

- **app**（`server/`）：发布状态机。四张表对应四类持久化状态——
  - `releases`：发布意图（`staging → activating → published | failed`）
  - `receipts`：每台采集器的暂存回执（设备确认后才落库）
  - `generations`：生效代次，单调递增，仅在**全部目标回执摘要匹配**时在单事务内原子推进
  - `activations`：每台采集器的**生效确认**（设备实际报告的发布编号/摘要/代次），全部目标确认一致后发布才置 `published`
- **devices**（`devices/`）：采集器模拟器，独立进程、独立存储卷。同一设备对同一发布编号幂等暂存：同摘要重发返回原回执，异摘要返回 409 且保留首次内容；最终切换幂等且代次不得回退。
- **verify**（`verify/`）：代码测试 + 构建检查 + API 冒烟，跑完即退出并给出退出码。

## 关键语义

| 场景 | 行为 |
| --- | --- |
| 页面重试 / 重传（同标识同载荷） | 返回**与当前恢复阶段一致的原结果**（HTTP 200 + `duplicate: true`），代次不重复推进；未完结时一并驱动核对补齐 |
| 同标识异载荷 | **409 冲突**（`RELEASE_KEY_CONFLICT`），不产生新发布 |
| 个别设备迟到 / 不可达 | 发布保持 `staging`；启动核对、周期核对（10s）与手动核对会幂等补发 |
| 进程在“设备已暂存、回执未落库”间退出 | 重启后向模拟器**核对并补记**回执，再评估推进 |
| 进程在“逐台最终切换”途中退出 | 发布保持 `activating`（代次已指派但**不显示已发布**）；重启后继续核对并**补齐未完成设备**，全部确认一致才置 `published` |
| 任一设备暂存摘要不符 | 发布判为 `failed`，**代次不得推进**，判负为终态 |
| 任一设备实际生效摘要/代次不符 | 发布**不得认定为完成**（保持 `activating`），后续发布**不得越过**尚未完成的生效顺序 |
| 页面展示 | 只读服务端已确认信息（回执/生效确认落库才可见）；`activating` 的代次不作为当前生效代次 |

## 快速开始

```bash
# 启动发布页 + 接口 + 设备模拟器（宿主端口可用 APP_PORT 覆盖）
APP_PORT=8080 docker compose up --build app

# 打开页面
open http://localhost:8080
```

健康检查：`GET /api/health`（Dockerfile 内置 HEALTHCHECK，Compose `depends_on: service_healthy` 依赖它）。

## 验证（verify 服务）

```bash
docker compose up --build --exit-code-from verify --abort-on-container-exit verify
```

verify 依次执行，任一失败即非零退出：

1. **代码测试**：`server/` 单元测试（摘要、幂等重传、冲突、迟到设备、崩溃补记、不符判负、代次单调性、入参校验，以及**最终切换前/切换途中/确认丢失等中断边界的重启恢复**）
2. **构建检查**：前端 `vite build` + 服务端模块加载检查
3. **API 冒烟**（`verify/smoke.mjs`）：正常发布推进代次 → 重复发布返回原结果 → 同标识异载荷 409 → 崩溃窗口回执补记 → 设备摘要被篡改后保持未发布且代次不受污染 → 已完成发布重传幂等 → **最终切换途中崩溃：恢复前不显示已发布，重传/核对补齐后只产生一个发布结果和一个代次且全目标实际生效一致** → **设备拒绝最终切换：不显示完成、当前代次不提前、后续发布不得越过** → 受阻设备恢复后按序收敛（环境不留阻塞，冒烟可重复运行）

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/devices` | 采集器清单 |
| POST | `/api/releases` | 提交发布 `{releaseKey, targets[], params}` → 201 / 200(重复) / 409(冲突) |
| GET | `/api/releases` | 发布列表（含汇总阶段、回执统计、生效确认、生效代次） |
| GET | `/api/releases/:id` | 发布详情（逐台回执摘要与逐台生效确认） |
| POST | `/api/releases/:id/reconcile` | 对单个发布核对并补齐（回执补记 + 最终切换补齐） |
| POST | `/api/admin/reconcile` | 对全部未完结发布核对并补齐 |
| GET | `/api/generation/current` | 当前生效代次（仅统计全部目标已确认的发布） |
| POST | `/api/test-hooks/simulate-crash-after-stage` | 测试钩子：复现“回执落库前”崩溃窗口（`TEST_HOOKS=1` 时启用） |
| POST | `/api/test-hooks/simulate-crash-during-activation` | 测试钩子：复现“逐台最终切换途中”崩溃窗口（`TEST_HOOKS=1` 时启用） |

设备模拟器：`POST /devices/:id/stage`、`POST /devices/:id/activate`、`GET /devices/:id/stages/:releaseId`、`GET /devices/:id/active`、`GET /health`，测试钩子 `POST /test-hooks/corrupt`。

## 环境变量

| 变量 | 服务 | 默认 | 说明 |
| --- | --- | --- | --- |
| `APP_PORT` | 宿主 | `8080` | 发布页/接口的宿主端口 |
| `PORT` / `DATA_DIR` | app / devices | `8080` / `9000`，`/data` | 容器内端口与数据目录 |
| `SIMULATOR_URL` | app | `http://devices:9000` | 模拟器地址 |
| `KNOWN_DEVICES` | app | `collector-1,collector-2,collector-3` | 可选采集器清单 |
| `TEST_HOOKS` | app / devices | compose 中为 `1` | 测试钩子开关，生产请置 `0` |

## 本地开发（无 Docker）

```bash
cd devices && npm install && PORT=9000 DATA_DIR=/tmp/sim npm start
cd server  && npm install && PORT=8080 DATA_DIR=/tmp/app SIMULATOR_URL=http://localhost:9000 npm start
cd web     && npm install && npm run dev        # 开发热更新，代理 /api → 8080
# 或构建后由 server 直接托管：
cd web && npm run build                          # 产物 web/dist，server 启动即可访问
cd server && npm test                            # 单元测试
API_BASE=http://localhost:8080 SIMULATOR_URL=http://localhost:9000 node verify/smoke.mjs
```

状态持久化在各自 `DATA_DIR` 的 SQLite 中；删掉数据目录即重置（本版本调整了 `releases` 状态机并新增 `activations` 表，旧数据目录请重置后使用）。
