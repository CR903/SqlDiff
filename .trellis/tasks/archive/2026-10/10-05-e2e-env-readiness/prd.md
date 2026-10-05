# 5.7 真机 E2E 环境就绪 + dotenv 加载

## Goal

让 preflight 真机 E2E 能在 `.env.e2e` 填好后**一键跑通**，不再需要手工 `export` 一串变量、不再依赖写死的 IP。三件事：给 5.7 建远程账号、spec 去写死 IP、补 dotenv 加载。

## Background（已确认事实 · 2026-10-05 实测）

### 目标机盘点（实测推翻历史记录）

| 地址 | 状态 | 结论 |
|---|---|---|
| `192.168.2.115` | `root/<用户指定的 DB 密码，不入库>` 直连 OK，**MySQL 8.0.46** | 保留，作 8.x 目标 |
| `192.168.2.84` | `mysqld57` 服务 `active`，**MySQL 5.7.44**；但 `root` 只有 `root@localhost`，无 `root@%`，TCP 远程登录被拒 | 需建远程账号 |
| `192.168.5.9` / `.15` | **TCP 3306 可连但 MySQL 握手 ETIMEDOUT**（历史记录里的 8.0.46 / 8.0.26） | 已废弃 |

**用户补充的关键约束**：这些都是虚拟机，**每次重启 IP 会变**，所以 IP 不能写死在代码里，只能从 env 传。

### 现有缺口

1. **spec 写死 IP**：`preflight-on-mysql-8.spec.ts:50` `defaultHost = suffix === '9' ? '192.168.5.9' : '192.168.5.15'`（两台都已废弃）；`preflight-on-mysql-5-7.spec.ts:54` 写死 `192.168.2.84`。IP 一变，spec 静默指向错机器（或 skip），无提示。
2. **无 dotenv 加载**：全仓 `grep dotenv` 在 `e2e/` 无命中，spec 直接读 `process.env.*`。`.env.e2e.example` 开头写"复制为 `.env.e2e` 并填入真实密码"，但**填了也不会生效**，必须手工 `export`。这是文档与实现的实质偏差。
3. `dotenv@16.6.1` 已在 `node_modules`（`electron-builder` 的传递依赖，devDependencies 链），但**未在 package.json 显式声明**——不可依赖传递依赖。

## 用户决策

- **D1**：`.env.e2e` **入库模板 + dotenv 自动加载**，让示例真正开箱即用
- **D2**：5.7 远程账号**用用户给的密码** `<用户指定的 DB 密码，不入库>`
- **D3**：8.x spec **改成单台 8.0.46**，删掉 8.0.26 describe
- **D4**：IP 是虚拟机动态地址，**不得写死在代码默认值里**

## Requirements

- [ ] R1 在 `192.168.2.84` 的 5.7 上建远程账号（用户名 `sqldiff`，密码 `<用户指定的 DB 密码，不入库>`，host `%`），授予 fixture 库 ALL + 全局 `SELECT, REPLICATION CLIENT, SUPER`（`SUPER` 是 `READ_ONLY_TARGET` 用例 `SET GLOBAL read_only` 所需）
- [ ] R2 `dotenv` 提升为**显式 devDependency**（不从传递依赖借），在 `e2e/playwright.config.ts` 加载 `.env.e2e`；**已存在的 `process.env` 优先**，不覆盖外部传入值
- [ ] R3 两个 spec **移除写死 IP 默认值**：host 缺失时 **skip 并给出可诊断原因**，不再静默连一个可能过期的地址
- [ ] R4 8.x spec 删掉 8.0.26 describe 与对应 env 变量（`E2E_MYSQL_15_*`），只留 8.0.46 单机
- [ ] R5 `.env.e2e.example` 同步：删 8.0.26 段、8.0.46 主机改为占位说明（不写死 IP）、补 dotenv 自动加载说明；**`.env.e2e` 保持在 `.gitignore`**
- [ ] R6 单测：dotenv 加载逻辑（已存在 env 优先 / 缺失文件不报错 / 不覆盖）必须有测试——按 `quality-guidelines.md` 门禁
- [ ] R7 真机验证：`e2e:preflight:mysql` 与 `e2e:preflight:mysql57` 在两台机器上均跑通，产出三段对比证据（5.7 全 INPLACE+rebuild / 8.0.46 全 INSTANT），cleanup 后无残留库
- [ ] R8 无秘密入库：`.env.e2e` 不提交；`git grep` 扫不到真实密码；`.env.e2e.example` 只留占位

## Acceptance Criteria

- [ ] AC1 5.7 远程账号可从本机 TCP 登录，`SELECT VERSION()` 返回 5.7.44
- [ ] AC2 只创建 `.env.e2e`（不 export 任何变量）→ `npm run e2e:preflight:mysql57` 真实执行而非 skip
- [ ] AC3 IP 写错或 host 变量缺失时，spec skip 且输出明确诊断（缺哪个变量），不静默连错机器
- [ ] AC4 `grep -rn "192.168" apps/desktop/e2e/ apps/desktop/src-*/` 无写死 IP（示例文件里的说明性文字除外）
- [ ] AC5 两台真机 E2E 全绿；结束后 `SHOW DATABASES LIKE 'sqldiff_preflight_test%'` 为空
- [ ] AC6 dotenv 加载有单测；全套 `vitest` 不回归；`typecheck` / `lint` / `build` 全绿
- [ ] AC7 `git ls-files` 不含 `.env.e2e`；`git grep -i "DB.smarterlab"` 零命中

## Out of Scope

- 修复/启用 `192.168.5.9` / `192.168.5.15`（用户已确认废弃）
- 8.0.29 版本分叉（`DROP COLUMN` INSTANT 边界）真机覆盖——需要一台 8.0.12–8.0.28 的机器，用户未提供；5.7 + 8.0.46 已覆盖两侧极端
- SSH 隧道 / 私钥认证的真机覆盖（另见 `smoke-report2.md` 记录的服务端拒绝转发）
- UI 层 Preflight 按钮 E2E
- 把 IP 发现自动化（扫网段找 MySQL）——反模式，留给人工填 env

## Key Decisions

- D1–D4 已定（见上）
- dotenv 加载放在 `playwright.config.ts` 而非各 spec：单一入口，所有 e2e spec 一致受益，避免每个 spec 各写一遍
- 不做「IP 自动发现」：扫描网段会把测试环境的真实目标变成不确定来源，与"只读比对"的可追溯性冲突

## Open Questions

无。
