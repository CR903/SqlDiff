# CDP 交互面验证报告

- 日期：2026-09-30
- 平台：macOS（darwin x64），无头模式
- 被测代码：`c72df06`（feat 授权盲区）+ 已提交的三个 commit
- 方法：Electron `--headless=new --remote-debugging-port=9333` + CDP `Runtime.evaluate`（React 原生 setter 驱动表单，真实 IPC）
- 环境：隔离 MySQL 5.7.18 @ `127.0.0.1:3307`（临时 datadir），fixture `cov_src`/`cov_tgt`，账号 `cov_limited`（表级授权）

## 验证结论

| # | 交互面 | 结果 | 证据 |
|---|--------|------|------|
| C1 | 真实连接失败 → 错误卡片，不再回填 demo | ✅ | `connect ECONNREFUSED 127.0.0.1:1`；`statusbar` 显示「对比失败」；diffRows=0 |
| C2 | 错误卡片文案含排查指引 + 不展示示例差异 | ✅ | 「请检查 A / B 节点的连接地址、账号与密码后重试；此处不展示任何示例差异，避免与真实结果混淆」 |
| C3 | 覆盖计数常驻 + 可展开明细 | ✅ | `statusbar`：「2 个对象未检查（查看明细）」；展开显示 `open_view 视图 权限不足` ×2 |
| C4 | 可见性范围明示 + 可展开明细 | ✅ | 「本次比较范围为 A / B 双方均可见的 2 个对象；1 个对象因授权未参与比较」；展开显示 `secret_tbl 表 仅 B 侧可见` |
| C5 | 被排除对象不产生 CREATE/DROP | ✅ | 授权盲区场景 diff 为 0 条 |

## 关键路径

1. 通过「新增」保存 5 个节点：`cdp-bad`（127.0.0.1:1 不可达）、`cov-src`、`cov-tgt`（cov_limited 账号）
2. 场景 A（授权盲区）：`cov-src → cov-tgt` 对比 → 0 条差异 + 覆盖/可见性提示
3. 场景 B（真实失败）：`cdp-bad → cov-src` 对比 → 错误卡片

## 环境限制

- `window.__sqldiffStore` 未挂载到 window，无法直接注入 store 状态；全部通过真实 UI 交互驱动。
- `reliable: false` 措辞变体（SHOW GRANTS 失败路径）无法通过正常交互触发，未覆盖。
- 无头模式 EGL 报错不影响 CDP 协议与 renderer 逻辑。

## 遗留

- `reliable: false` 的「授权范围无法确认」措辞变体仍无交互证据（需人为断网/降权触发 SHOW GRANTS 失败）。
- 本报告未持久化截图，仅记录断言与观察；如需审计级复现需重跑。