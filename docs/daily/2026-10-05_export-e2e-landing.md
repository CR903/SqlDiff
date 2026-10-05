# 2026-10-05 export-e2e-landing

父任务 `10-05-contract-test-landing` 的子任务 B。任务文档见 `.trellis/tasks/10-05-export-e2e-landing/`。

## 做了什么

让两条**已声明但零断言**的契约变成真的，分两层：

**B1（纯单测，+17 项）**：`preflight.md §11.1` 把「导出物必须不含连接凭据」列为保密硬边界，但 `assertNoSecrets` 只用在 DataGrip/DBeaver，Preflight 与 Manifest 导出物**一条断言都没有**。新建 `tests/core/preflight-export-secrets.test.ts`：

- Preflight 四种产物（`serializePreflight` / 结论 md / 细节 md / v1 兼容）+ Manifest 两种产物
- 每产物**两层**断言：8 个敏感字段名 + 5 个哨兵值（`fake-sentinel-pw-9f3a` 等）
- `preflightFileNames` 3 文件名契约（含「恰好 3 个键」防回退成 2 份）

**B2（真机 UI E2E，2 项）**：`frontend/quality-guidelines.md:69` 明确要求导出按钮的 E2E，`e2e/` 里不存在。新建 `e2e/specs/export-ui.spec.ts`，真机走完整链路：UI 建两个节点 → `对比 ⚡` → `运行 Preflight` → `导出 Preflight 报告` → `导出审查报告`。

## 为什么必须真实点击

`导出 Preflight 报告` 读 renderer 的 React state `lastPreflightResult`（`App.tsx:2353`）。既有两份真机 preflight spec 全部走 `page.evaluate(() => api.preflight.run(...))`——**API 直调设不了这个 state**，所以它们验证不到导出层。这是既有覆盖的盲区，不是遗漏。

`canRunPreflight`（`App.tsx:673`）要求「真实比较 + ≥1 条表级 DDL 项」，因此 fixture 建 **A/B 双库**（B 多一列 → ADD COLUMN）。一次比较同时喂饱两个导出，正好对上 spec 的 "same CDP harness run" 要求。

## 质量

- **887 项全绿**（870 → +17，52 文件）；typecheck / lint / build 全绿
- **真机 2 passed（7.9s）**，真实点击非 skip；`.115` 无残留库
- **变异测试**：把真哨兵值 `fake-sentinel-pw-9f3a` 拼进 `inferences[].statement` → **1 failed**（报出「凭据值 fake-sentinel-pw-9f3a」），恢复后全绿
- 产品代码 `src-core/` `src-main/` `src-renderer/` 零改动

## 踩到的坑

**① 保密声明里的敏感词是假阳性，两层都踩了。** 产物含固定文案「本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）」——这是**否定式承诺本身**列举了敏感词。B1 与 B2 初版都把它判成泄漏。修法是判字段名前先 `stripConfidentialityNotes`。

**② 子代理的三处错断言（都是它自己写的）**：
- 用 `label.endsWith('md)')` 判断产物是否 markdown，而 v1 的 label 结尾是「(v1 兼容，detail 内嵌)」→ strip 没生效。**脆弱的标签后缀启发式**，已改为按产物类型判断
- 文件名断言 `not.toContain('.')` → 扩展名 `.json` 本来就带点，必然失败。已改为只判时间戳部分
- `manifest.stats` 键集合把 `INSERT`/`DELETE`/`UPDATE`（**DML 内层键**）当顶层键。已改为 6 个顶层键 + 单独断言 DML 内层

**③ 两份实现子代理都返回空结果**（工具异常）。改动已部分落盘，需要主会话核实进度并接手收尾。

## 终审的独立发现：Playwright trace 不掩码密码

终审发现一个**真实安全风险**：本 spec 要把 `.env.e2e` 的**真实密码**打进 UI 密码框（不这样连不上真机），而 **Playwright 1.63 不会对 `type=password` 做掩码**——实测明文出现在 `trace.zip` 的 `test.trace` 里（`{"title":"Fill \"<明文>\""}` 与 `{"params":{"value":"<明文>"}}` 两处）。config 原本是 `trace: 'retain-on-failure'`，一旦失败密码就留在 `test-results/`。

处置：本 spec 默认 `trace: 'off'`，需排查时用 `E2E_TRACE=1` 临时打开、排查完删目录。代价是默认没有 trace（改用 `error-context.md` + list reporter 定位）。**这是「秘密不落盘」与「失败可诊断」的显式取舍，偏向安全。**

## 可沉淀知识

已并入 [`docs/knowledge/common/best-practices/assertion-and-doc-fidelity.md`](../knowledge/common/best-practices/assertion-and-doc-fidelity.md)（同一主题，不新建文件）：新增第三节「按产物类型分层判据，不要按标签字符串猜」。

索引无需再动（该文件已在 `common/best-practices/index.md` 中）。

## 遗留 / 后续

- **5.7 真机当前不可达**：`192.168.2.84`（5.7.44）socket 超时，`npm run e2e:preflight:mysql` 的两项 5.7 用例失败（`ETIMEDOUT` / `EHOSTDOWN`）。经 socket 独立核实为**虚拟机环境问题，非代码回归**（`.115` 正常，同一次运行 8.x 两项通过）。用户已说明这些是虚拟机、IP 会变。**机器恢复后需重跑确认。**
- **两层 §11.1 判据刻意不共享**（单测不能 import `e2e/`）。代价是 `CONFIDENTIALITY_NOTES` 两处文案要同步改，漏一处每个导出都会假红。已在两处注释里互相指认。
- **8.0.12–8.0.28 中间版本真机覆盖**仍缺（需新机器）。
