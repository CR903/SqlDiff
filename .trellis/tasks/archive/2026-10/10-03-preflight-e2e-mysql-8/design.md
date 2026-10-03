# Preflight E2E on MySQL 8 — Design

## Architecture / Boundaries

改动只落在测试基础设施，不动产品代码：

```
apps/desktop/e2e/
├── playwright.config.ts                    已存在（不修改）
├── fixtures/
│   ├── test-nodes.ts                       已存在（不修改）
│   └── mysql-fixture.ts                    【新】建 8 表 fixture 库 + cleanup
├── helpers/
│   ├── electron.ts                         已存在（不修改）
│   ├── assertions.ts                       已存在（不修改）
│   └── preflight-fixture.ts                【新】手工构造 PreflightRequest.items + 断言工具
└── specs/
    ├── dbeaver-export.spec.ts              已存在（不修改）
    ├── datagrip-export.spec.ts             已存在（不修改）
    ├── ui-smoke.spec.ts                    已存在（不修改）
    └── preflight-on-mysql-8.spec.ts        【新】参数化双机测试

package.json
└── scripts
    └── "e2e:preflight:mysql": "..."        【新】独立 npm script

环境变量（.env.e2e 或 shell export）
├── E2E_MYSQL_9_HOST=192.168.5.9
├── E2E_MYSQL_9_PASSWORD=...
├── E2E_MYSQL_15_HOST=192.168.5.15
├── E2E_MYSQL_15_PASSWORD=...
└── E2E_RUN_PREFLIGHT_MYSQL=1              开关：未设则整套 spec skip
```

**核心原则**：
1. **不改产品代码**：harness 只做观测，不修改 `src-main/preflight-*` / `src-core/preflight-*`
2. **依赖可切换**：环境变量缺失时 spec 全部 `test.skip()`，避免在无 MySQL 环境跑 CI 时失败
3. **Cleanup 强制**：`afterAll` 里 DROP DATABASE 无论测试成败
4. **双机串行**：`workers: 1`，8.0.26 跑完再 8.0.46，方便对比断言

## Contracts

### 1. Fixture 数据库 schema（`mysql-fixture.ts` 建库）

```sql
-- 8 表 fixture：覆盖 preflight 9 条规则的触发面
CREATE DATABASE sqldiff_preflight_test_{VERSION_SHORT} CHARACTER SET utf8mb4;
USE sqldiff_preflight_test_{VERSION_SHORT};

-- 1. orders_empty: 有 PK、空表（baseline）
CREATE TABLE orders_empty (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. users_big: 有 PK、~100 万行（触发 BIG_TABLE_COPY + LARGE_TABLE_INSTANT_ADD）
--    数据用 INSERT ... SELECT 循环翻倍 20 次达到 100 万
CREATE TABLE users_big (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255),
  name VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO users_big (email, name) VALUES ('seed@example.com', 'seed');
-- 翻倍 20 次：INSERT INTO users_big (email, name) SELECT CONCAT(id,'@x.com'), name FROM users_big;
-- 20 次后 ≈ 100 万行

-- 3. products_no_pk: 无主键（触发 NO_PRIMARY_KEY）
CREATE TABLE products_no_pk (
  name VARCHAR(100),
  price DECIMAL(10,2)
);

-- 4. tags_unique: 有 UNIQUE 索引
CREATE TABLE tags_unique (
  id BIGINT PRIMARY KEY,
  slug VARCHAR(100),
  UNIQUE KEY idx_slug (slug)
);

-- 5. events_fk: 有外键
CREATE TABLE events_fk (
  id BIGINT PRIMARY KEY,
  user_id BIGINT,
  event_type VARCHAR(50),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users_big(id)
);

-- 6. config_wide: 宽表（100 列，触发列多场景）
CREATE TABLE config_wide (
  id BIGINT PRIMARY KEY,
  c01 VARCHAR(50), c02 VARCHAR(50), ..., c100 VARCHAR(50)
);

-- 7. audit_pk_unique: PK + UNIQUE 组合
CREATE TABLE audit_pk_unique (
  id BIGINT PRIMARY KEY,
  audit_key VARCHAR(100),
  payload JSON,
  UNIQUE KEY idx_audit_key (audit_key)
);

-- 8. slow_log_no_index: 有数据无索引
CREATE TABLE slow_log_no_index (
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  msg TEXT
);
INSERT INTO slow_log_no_index (msg) VALUES ('bootstrap');
```

**数据量控制**：`users_big` 用翻倍 INSERT，20 次后 ≈ 100 万行，MySQL 8.0 上耗时约 5-15 秒。其他表仅少量数据。

### 2. PreflightRequest.items 手工构造（`preflight-fixture.ts`）

覆盖 11 种 DDL 分类（不含 CREATE/DROP TABLE，因为 preflight 不处理这些）：

```ts
export function buildFixtureItems(): DiffItem[] {
  return [
    { id: 'd01', objectType: 'table', sql: "ALTER TABLE users_big ADD COLUMN nickname VARCHAR(50)", verb: 'CHANGE', aspect: 'column' },
    { id: 'd02', objectType: 'table', sql: "ALTER TABLE orders_empty DROP COLUMN created_at", verb: 'DROP', aspect: 'column' },
    { id: 'd03', objectType: 'table', sql: "ALTER TABLE products_no_pk ADD INDEX idx_name (name)", verb: 'CHANGE', aspect: 'index' },
    { id: 'd04', objectType: 'table', sql: "ALTER TABLE tags_unique ADD UNIQUE INDEX idx_new (name)", verb: 'CHANGE', aspect: 'index' },
    { id: 'd05', objectType: 'table', sql: "ALTER TABLE events_fk DROP INDEX idx_legacy", verb: 'DROP', aspect: 'index' },
    { id: 'd06', objectType: 'table', sql: "ALTER TABLE config_wide ADD PRIMARY KEY (id, c01)", verb: 'CHANGE', aspect: 'pk' },
    { id: 'd07', objectType: 'table', sql: "ALTER TABLE audit_pk_unique CHANGE COLUMN audit_key new_key VARCHAR(200)", verb: 'CHANGE', aspect: 'column' },
    { id: 'd08', objectType: 'table', sql: "ALTER TABLE slow_log_no_index MODIFY COLUMN msg MEDIUMTEXT", verb: 'CHANGE', aspect: 'column' },
    { id: 'd09', objectType: 'table', sql: "ALTER TABLE tags_unique CONVERT TO CHARACTER SET utf8mb4", verb: 'CHANGE', aspect: 'char' },
    { id: 'd10', objectType: 'table', sql: "ALTER TABLE orders_empty ENGINE=InnoDB", verb: 'CHANGE', aspect: 'engine' },
    { id: 'd11', objectType: 'table', sql: "ALTER TABLE events_fk ADD PARTITION (PARTITION p0 VALUES LESS THAN (1))", verb: 'OTHER' },  // 落 OTHER → unparsed-ddl Unknown
  ];
}
```

### 3. 版本矩阵断言（`preflight-on-mysql-8.spec.ts`）

对**同一条** DDL 字符串，两台机器的 Inference `algorithm` 表现：

| DDL 类别 | 8.0.26 (<8.0.29) | 8.0.46 (≥8.0.29) |
|---|---|---|
| `ADD COLUMN` (no default) | INSTANT (≥8.0.12) | INSTANT (≥8.0.12) |
| `DROP COLUMN` | **INPLACE + rebuildsTable=true** | **INSTANT + rebuildsTable=false** |
| `MODIFY COLUMN` | INPLACE + rebuildsTable=true | INPLACE + rebuildsTable=true |
| `CHANGE COLUMN` | INPLACE + rebuildsTable=true | INPLACE + rebuildsTable=true |
| `ADD UNIQUE INDEX` | INPLACE + rebuildsTable=true | INPLACE + rebuildsTable=true |
| `ADD PRIMARY KEY` | INPLACE + rebuildsTable=true | INPLACE + rebuildsTable=true |

关键断言锚点：
- **ADD_COLUMN 双机一致**：都应有 `algorithm='INSTANT'` Inference
- **DROP_COLUMN 分叉**：8.0.26 → `INPLACE`；8.0.46 → `INSTANT`
- **其他重建类**：双机一致 INPLACE + rebuildsTable=true

### 4. 触发规则断言

| Fixture 表 + DDL | 预期触发的 Issue |
|---|---|
| `users_big` (~100 万行) + `ADD_COLUMN` | `LARGE_TABLE_INSTANT_ADD` (positive, warn) |
| `users_big` (~100 万行) + `CHANGE_ENGINE` | `BIG_TABLE_COPY` (block) |
| `products_no_pk` + `DROP INDEX` | `NO_PRIMARY_KEY` (warn) |
| 临时 `read_only=1` | `READ_ONLY_TARGET` (block) |

**注**：`BIG_TABLE_COPY` 阈值默认 100 万行，`users_big` 需 ≥100 万。翻倍 20 次正好达到。

## Data Flow

```
npm run e2e:preflight:mysql
    ↓
playwright.config.ts 加载 specs/preflight-on-mysql-8.spec.ts
    ↓
test.beforeAll:
    ├─ 读环境变量 E2E_MYSQL_9_* / E2E_MYSQL_15_*
    ├─ 若 E2E_RUN_PREFLIGHT_MYSQL !== '1' → test.skip() 整套
    └─ 若 E2E_MYSQL_9_PASSWORD 或 E2E_MYSQL_15_PASSWORD 未设置 → 跳过对应机器 test
    ↓
test.describe('Preflight on MySQL 8.0.26', ...) 
    ├─ 建库 fixtureMySQL8_0_26 (192.168.5.15)
    ├─ createNode(192.168.5.15, ...) via api.nodes.create
    ├─ const report = await api.preflight.run({ bId, items: buildFixtureItems(), bAlias, bDatabase })
    ├─ assertReport(report, expectedVersion='8.0.26', expectedDropAlgo='INPLACE')
    └─ finally: dropDatabase + deleteNode
    ↓
test.describe('Preflight on MySQL 8.0.46', ...)
    ├─ 建库 fixtureMySQL8_0_46 (192.168.5.9)
    ├─ ... 同上
    └─ expectedDropAlgo='INSTANT'
    ↓
test.afterAll: 清理残留
    ├─ SHOW DATABASES LIKE 'sqldiff_preflight_test%' → DROP
    └─ 清理测试节点
```

## Trade-offs

| 选择 | 代价 | 理由 |
|---|---|---|
| 手工构造 PreflightRequest.items | 与真实 compare 输出可能语义漂移 | preflight 消费的 DDL 字符串上游已由 compare 保证；本次只验 preflight 消费能力 |
| 独立 npm script | 与 `npm run e2e` 主 harness 分离 | 依赖外部 MySQL，CI 环境无法保证可达 |
| 双机串行 | 跑完全套 ≈ 2 分钟（含建库） | 要对比算法差异必须串；并行无法断言「同一 DDL 在不同版本的分叉」 |
| 不启用主从 fixture | REPLICA_LAG 规则端到端未测 | 建主从配置复杂，5.7 缺口一起推到 follow-up |
| users_big 用翻倍 INSERT | 数据分布不均匀（id 幂乘 2） | 5-15 秒能到 100 万行，比真实写入快 10 倍 |

## Compatibility

- **不改**产品代码，`git diff -- apps/desktop/src-{main,core,renderer}/` 应仅包含 e2e 目录与 package.json
- **不新增**生产依赖（只用现有 mysql2、playwright）
- **不影响** CI：`.env.e2e` 缺失时 spec 全套 skip
- **不修改**现有 e2e harness 与已有 spec

## Rollout / Rollback

**Rollout**：
1. 写 `mysql-fixture.ts` → 单测：连接 + 建库 + cleanup 单跑一遍
2. 写 `preflight-fixture.ts` → 单测：构造 items + 断言工具
3. 写 spec → 手动跑一次 8.0.26 单机
4. 双机跑通 → 更新 e2e-harness.md

**Rollback**：删除 e2e 三个新文件 + 移除 package.json script + 移除 spec 更新段落，产品代码零回滚

## Operational Notes

- Fixture 建库耗时预算 90 秒（含 users_big 翻倍 20 次）
- 若 fixture 建库失败，测试应失败而非 skip（说明环境问题）
- 若 MySQL 连接失败，测试 skip（说明网络问题，非产品问题）
- Fixture 库名后缀 `_{VERSION_SHORT}` 避免双机冲突（虽然不在同机，但保持一致）
- Cleanup 用 DROP DATABASE，不用 TRUNCATE，确保完全清理
- 测试运行前打印版本确认信息，方便日志排查
