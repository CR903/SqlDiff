# design.md — E2E 环境就绪 + dotenv 加载

## 边界

三处改动，互不重叠：

1. **远端环境**（5.7 MySQL 账号）—— 不在本仓库，只在 `192.168.2.84` 上
2. **测试基础设施**（`playwright.config.ts` + 两个 spec + `.env.e2e.example`）—— 本仓库
3. **单测**（dotenv 加载逻辑）—— 本仓库 `tests/main/`

产品代码（`src-core/` / `src-main/` / `src-renderer/`）**零改动**，数据库查询与只读边界不受影响。

## dotenv 加载设计

### 为什么放 playwright.config.ts

`defineConfig` 的文件本身在 Playwright 收集测试前被求值，所以配置里的副作用对所有 spec 可见。放在这里：

- 单一入口，新增 e2e spec 自动受益，不需要每个 spec 记得调用
- 不进产品代码路径（配置只在 Playwright 进程里跑）
- 对 `vitest` 无影响（vitest 不读 playwright.config.ts）

### 加载语义（关键：外部 env 优先）

```
process.env 已有的键  →  保持不变（命令行 / CI secret 优先）
仅在 .env.e2e 里存在  →  注入
```

必须"已有优先"。否则开发者 `E2E_MYSQL_57_PASSWORD=x npm run e2e:...` 会被文件里的旧值覆盖，CI 注入的 secret 也可能被本地文件顶掉——这是安全边界，不只是便利性。

### 缺失文件必须静默

`.env.e2e` 不存在是**正常状态**（主 harness 不需要它）。加载失败必须静默返回，让 spec 自己的 skip 逻辑给出诊断，而不是抛栈中断整个 e2e 运行。

### 依赖处理

`dotenv` 当前只是 `electron-builder` 的传递依赖。必须显式加进 `devDependencies`：

- 传递依赖随上游升级可能消失，`npm ls` 干净 ≠ 稳定存在
- 显式声明让 `package-lock.json` 记录直接依赖关系

## spec 去写死 IP

### 现状问题

```ts
const defaultHost = suffix === '9' ? '192.168.5.9' : '192.168.5.15';
```

虚拟机 IP 每次重启都会变（用户明确说明）。写死默认值的后果是：IP 变了以后，spec 要么 skip（密码缺失）要么**连到错误的那台机器**——后者更糟，因为它看起来跑通了。

### 改法

```ts
const host = process.env[`E2E_MYSQL_${suffix}_HOST`];   // 无默认值
if (!host || !password) {
  test.skip(true, `E2E_MYSQL_${suffix}_HOST / _PASSWORD 未设置（IP 是动态的，请填入 .env.e2e）`);
}
```

skip 消息要说明**为什么**需要这个变量（IP 动态），否则下一个人会以为可以写死回去。

### 8.x 单机化

删掉 8.0.26 describe 后，`suffix` 参数化只剩一个取值，`loadMysqlEnvConfig('9'|'15')` 的分支失去意义。简化成读 `E2E_MYSQL_8_*` 还是保留 `E2E_MYSQL_9_*`？

**保留 `E2E_MYSQL_9_*` 不改**：`9` 是历史命名（对应旧网段第 9 台），改名会让已有的 `.env.e2e` 和任何外部文档失效，而它现在只是个不透明的标签。单机的语义由 describe 名（`MySQL 8.0.46`）和 `versionLabel` 承载，不依赖变量名的数字。

## 5.7 远程账号

```
CREATE USER 'sqldiff'@'%' IDENTIFIED BY '<用户给定密码>';
GRANT ALL PRIVILEGES ON `sqldiff_preflight_test_5_7`.* TO 'sqldiff'@'%';
GRANT SELECT, REPLICATION CLIENT, SUPER ON *.* TO 'sqldiff'@'%';
```

- `ALL` on fixture 库：建表/灌数据/删除库，fixture 需要
- 全局 `SELECT`：读 `information_schema` / `SHOW CREATE`
- `REPLICATION CLIENT`：`SHOW SLAVE STATUS`（5.7 无 `SHOW REPLICA STATUS`，走降级链）
- `SUPER`：唯一用途是 `READ_ONLY_TARGET` 用例的 `SET GLOBAL read_only`；这是**测试专用开关**，用完立刻还原（spec 的 `finally` 已保证）

这是 dev 测试机的专用账号，不是生产凭据。它进 `.env.e2e`（gitignored），不进仓库。

## 兼容与回滚

- dotenv 加载：删掉 config 里的 3 行即回滚；spec 退回"必须手工 export"
- spec 去写死 IP：独立改动，回滚不影响 dotenv
- 5.7 账号：`DROP USER` 即可；不影响本机 `root@localhost`
- 三者无耦合，可独立回滚

## 权衡

**不做 IP 自动发现**（扫网段找 MySQL）：会把"用户指定的测试目标"变成"碰巧扫到的某台机器"，破坏可追溯性——报告里说比了 A 库，实际可能连的是 C 库。人工填 env 虽然麻烦，但每次比的目标是明确、可复查的。
