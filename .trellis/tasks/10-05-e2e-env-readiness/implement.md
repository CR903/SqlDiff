# implement.md — E2E 环境就绪 + dotenv 加载

## 有序检查表

1. **5.7 远程账号**（环境操作，不在仓库）
   - SSH 上 `192.168.2.84`，用 `root@localhost` 登录
   - `CREATE USER 'sqldiff'@'%' IDENTIFIED BY '<用户给定>'`
   - 授予 fixture 库 ALL + 全局 `SELECT, REPLICATION CLIENT, SUPER`
   - 从本机 TCP 验证：`SELECT VERSION()` 应返回 5.7.44

2. **dotenv 加载**
   - `package.json` devDependencies 显式加 `dotenv`（当前只是传递依赖）
   - `e2e/playwright.config.ts` 加载 `.env.e2e`，**已存在的 `process.env` 键不覆盖**，文件缺失静默返回
   - 加载逻辑抽成可单测的纯函数（便于按门禁 R6 写测试）

3. **spec 去写死 IP**
   - `preflight-on-mysql-8.spec.ts`：删 8.0.26 describe 与 `E2E_MYSQL_15_*`；`defaultHost` 改为无默认值 + skip 诊断
   - `preflight-on-mysql-5-7.spec.ts`：同样去默认值
   - skip 消息说明 IP 是动态的、需要填 `.env.e2e`

4. **`.env.e2e.example`**：删 8.0.26 段；8.0.46 段改为占位说明；补 dotenv 自动加载说明；确认 `.env.e2e` 仍在 `.gitignore`

5. **单测**：dotenv 加载三态（外部 env 优先 / 缺失文件静默 / 不覆盖已有）

6. **本地 `.env.e2e`**（gitignored，不提交）：填两台机器的真实 host 与密码，开关置 1

7. **真机验证**：两台各跑一次，核对版本分叉断言，cleanup 无残留

## 验证命令

```bash
cd apps/desktop

# 单测 + 门禁
npx vitest run
npm run typecheck && npm run lint && npm run build

# 静态检查：不应有写死 IP
grep -rn "192\.168\." e2e/ src-core/ src-main/ src-renderer/

# 秘密检查
git ls-files | grep -c "\.env\.e2e"        # 期望 0
git grep -i "DB.smarterlab"                  # 期望无命中

# 真机（依赖 .env.e2e，无需 export）
npm run e2e:preflight:mysql
npm run e2e:preflight:mysql57

# cleanup 确认（两台分别执行）
# SHOW DATABASES LIKE 'sqldiff_preflight_test%'  → 空
```

## 高风险点与回滚

- **dotenv 覆盖顺序写反**：会让 CI 注入的 secret 被本地文件顶掉，属安全边界。实现后必须用单测锁住"外部 env 优先"，并人工验证一次 `E2E_MYSQL_57_PASSWORD=wrong npm run e2e:preflight:mysql57` 仍因密码错而失败（而非读到文件里的正确密码）
- **删 8.0.26 describe** 后 `suffix` 参数化只剩一值：确认没有残留的 `'15'` 分支或 `E2E_MYSQL_15_*` 引用
- **5.7 账号的 `SUPER` 权限**：只服务于 `SET GLOBAL read_only` 测试用例；确认 spec 的 `finally` 还原逻辑仍在（读_only 残留会影响开发机后续使用）
- 三处改动无耦合，可独立 revert

## start 前检查

- [ ] `implement.jsonl` / `check.jsonl` 已填真实条目
- [ ] 最终规划 summary 已向用户展示并获批
