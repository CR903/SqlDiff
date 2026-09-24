# E2E 全面测试报告

日期：2026-09-24 · 平台：macOS（darwin x64）· 被测：apps/desktop v0.1.0（HEAD `19cec8a`，含 `73ddc77` 图标管线）
方法：Electron `--remote-debugging-port=9333` + CDP（`Runtime.evaluate` 读状态、`Input.dispatchMouseEvent` **可信点击**、`Page.handleJavaScriptDialog` 处理 confirm、剪贴板/文件实证）
证据：本目录 `evidence/*.png`（表中使用相对 `evidence/` 路径）

## 测试环境

- 对比数据库：Docker `mysql:8.0`（127.0.0.1:3307），fixture `e2e_src`(A) vs `e2e_tgt`(B)
  - 结构差异：users（缺 age 列 + 2 个索引）、only_in_src（仅A）、only_in_tgt（仅B）、v_src_view/v_tgt_view
  - 数据差异：buildings（A1行/B3行，含同 key 改值）、pair_kv（**联合主键** A2/B2）、no_pk_table（**无主键**）、users（0/0）
- 说明：指定内网库 `192.168.0.5:3306` 在本次执行中未完成可用 MySQL 连接（原 harness 记录为 EHOSTUNREACH/timeout；本次 CLI 复核亦返回连接错误 65），因此改用 Docker 造等价 fixture；该 fixture 覆盖了结构、联合主键、无主键和小表数据，但不等于指定 `smarterlab` / `smarterlab_zky` 真库验证。

## 用例结果

| # | 用例 | 结果 | 关键证据 |
|---|------|------|----------|
| T1 | 冷启动：标题/三栏（截图是种子演示态；空对比态另见 T2a） | ⚠️ | `evidence/t1-cold-start.png` |
| T2a | 新增弹窗空校验（必填拦截） | ✅ | `evidence/t2-new-conn-fail.png` |
| T2b | 填表 → 测试连接失败（中文结构化，无 `Error invoking`） | ✅ | `evidence/t2-new-conn-fail.png`；toast `连接失败 [MYSQL_CONNECT] … ECONNREFUSED` |
| T2c | 保存 → 下拉出现 + 左侧「全部」可见 | ✅ | `evidence/t2-after-save.png` |
| T2d | 落盘：meta 入 nodes.json、密钥 safeStorage 加密、无明文 | ✅ | 临时 user-data 文件断言：`provider=safestorage` |
| T2e | 编辑：预填 + 分组持久化 + 密码留空不动 | ✅ | 临时 user-data 断言：`groupPersisted=true` |
| T2f | 删除：confirm → 左侧/下拉消失 + nodes.json/密钥清理 | ✅ | `evidence/t2-after-delete.png` |
| T3a | demo 兜底对比（种子节点）+ 错误消毒 | ✅ | `evidence/t3a-demo.png` |
| T3b | Docker MySQL fixture 节点连接测试 | ✅ | `evidence/t3c-nodes.png` |
| T3c | Docker fixture 结构对比：7 条差异（CREATE2/DROP2/CHANGE3） | ✅ | `evidence/t3c-struct.png` |
| T4a | 对象 chip 多选（只看表 5/7，取消复原 7） | ✅ | `evidence/t3d-chip-table.png` |
| T4b | 动词 chip 多选（DROP 桶） | ✅ | `evidence/t3d-drop-copy.png` |
| T5a | Docker fixture 数据对比：4 表处理，I1/D3/U2 | ✅ | `evidence/t5-data-only.png` |
| T5b | 联合主键（pair_kv）WHERE `region`+`code` 正确 | ✅ | `evidence/t5c-chinese-update.png` |
| T5c | 无主键表跳过 + 精确原因 + 替代策略 | ✅ | 状态行 `无可用行身份…加主键（或全列 NOT NULL UNIQUE）` |
| T5d | 中文端到端：`塔楼A中文` 读取/展示/复制无乱码 | ✅ | `evidence/t5b-chinese-ok.png`；见下方备注 |
| T6a | 导出落盘：文件存在、头注释、条数=列表 | ✅ | 临时 Downloads 断言：`sqldiff_*.sql` items=rows |
| T6b | 0 条导出：不产生文件 | ✅ | 临时 Downloads 断言：`noFileOnEmpty=true` |
| T7 | 密钥安全复核：4 个 secret 文件全 safeStorage，无明文 | ✅ | 临时 user-data 断言 |
| T8a | 交换 A/B | ✅ | 临时 CDP 断言：`swapWorked=true` |
| T8b | Cmd+Enter 快捷键触发对比（2→13 条） | ✅ | `evidence/t8-smoke.png` |
| T8c | 节点搜索过滤 | ✅ | 临时 CDP 断言：hit=1 |

**结论：报告记录 22/22 条测试动作已执行，在 demo/Docker fixture 可用范围内通过；本次复核未能在指定内网真库重跑，且部分环境限制见下文，不能据此宣称 AC1 完全关闭。**

## 备注与观察（非缺陷）

1. **fixture 编码插曲**：首次 fixture 用 `docker exec -i mysql`（客户端默认 latin1）灌入中文，导致库里存的是双重编码字节（HEX `C3A5C2A1…`），应用读出来自然也是 `å¡”æ¥¼`。用 `--default-character-set=utf8mb4` 重灌后应用端到端显示 `塔楼A中文` 正常。**应用读写路径无问题**，是测试数据构造问题。
2. **空结果导出提示**：0 条时预览区显示占位文案「暂无 SQL — 先对比…」，而不是 toast「暂无可导出 SQL」（按钮在 0 条时已提前 return，toast 分支不可达）。行为正确（无文件产生），仅提示位置可优化。
3. **真实对比失败会降级为 demo 示例数据**：当节点不存在/连接失败时，UI 会用本地示例数据填充并 toast 说明原因（`后端对比失败，已用本地示例数据演示（原因）`）。功能上可演示，但对真实用户可能造成「以为拿到了真实差异」的误读——建议后续在降级态给明显的视觉标识（如结果区顶部黄色「示例数据」横幅）。属产品决策，未改。
4. **指定真库仍未闭环**：本轮结构/数据证据来自 Docker fixture；`192.168.0.5:3306` 的真实连接与两库差异尚未得到可用凭证下的实证。SSH 单跳真机验证仍待用户提供可达节点+密钥。
5. **T1 证据边界**：`evidence/t1-cold-start.png` 展示的是内置种子演示态，空对比态由 `evidence/t2-after-save.png` / `evidence/t2-after-delete.png` 覆盖；不能把 T1 截图单独解读为“空节点库冷启动”。
6. **可审计性限制**：剪贴板、Downloads 文件、临时 user-data 的原始内容/命令日志未持久化到 task 目录，报告保留断言结果与 UI 截图；需要审计级复现时应在目标环境重跑并归档这些产物。

## 环境清理

- Docker 容器 `sqldiff-e2e-db`（测试后已 `docker rm -f`）
- 应用 user-data 中的 e2e 节点/密钥已通过 UI 删除路径清理
- 测试 harness 全部在 `$TMPDIR`，未入库

---

## AC 状态（本次复核）

| AC | 状态 | 结论 |
|----|------|------|
| AC1 T1-T8 | ⚠️ 部分通过 | demo/Docker fixture 范围动作完成；指定真库未闭环，T1 空状态证据在 T2 而非 T1 截图 |
| AC2 图标 | ✅（环境受限） | `npm run icon`、ICNS/ICO 多尺寸、builder 引用及 mac/Windows 包内嵌入均核验；未在 Windows Explorer 启动查看 |
| AC3 三安装包 | ✅（环境受限） | x64/arm64 DMG 与 x64 NSIS 均生成，架构/图标/校验通过；Windows 真机启动未执行 |
| AC4 只读/凭证 | ⚠️ 部分通过 | Docker fixture 全程只读且任务目录无凭证；指定 `smarterlab` 真库尚未完成连接实证 |
| AC5 三件套/老代码 | ✅ | `tsc`、lint、159 tests 全绿；`mysqldiff/` 相对任务基线零改动 |

# 应用图标

## 设计

`apps/desktop/scripts/icon-source.html` — 纯内联 SVG，无外部字体/网络依赖：

- 暗色圆角面板（`#172033→#080b10`）+ 淡网格（呼应产品深色科技风）
- 左靛蓝柱 `A`（来源库）/ 右青柱 `B`（目标库），产品色 `#6366f1` / `#22d3ee`
- 中间双向 diff 箭头 + 底部靛白青三段 diff 线 + `SQL` 字标
- 小尺寸（≤32px）自动切 compact 变体：去掉文字/网格，箭头与柱体加粗，保证 16px 仍可辨识

## 产物（`apps/desktop/build/icon/`）

| 文件 | 说明 | 核验 |
|------|------|------|
| `icon.png` | 1024×1024 RGBA 源 | `sips` 确认 1024×1024 |
| `icon-{16,32,48,64,128,256,512,1024}.png` | 多尺寸渲染 | 全部非空 |
| `icon.icns` | macOS 图标（iconutil 生成） | 1.2MB，mac 包内已验证 |
| `icon.ico` | Windows 图标 | 6 尺寸（16/32/48/64/128/256）全部 PNG-in-ICO、32bpp |

生成命令：`npm run icon`（可重复执行；改图标源后必须重跑再 `npm run pack`）。
`electron-builder.yml` 已显式挂 `mac.icon: build/icon/icon.icns` / `win.icon: build/icon/icon.ico`。

# 打包产物核验

| 产物 | 大小 | 架构 | 校验 |
|------|------|------|------|
| `release/SqlDiff-0.1.0.dmg` | 119M | mac x64 | `hdiutil verify` → VALID；`release/mac/SqlDiff.app/Contents/MacOS/SqlDiff` 为 x86_64；`Contents/Resources/icon.icns` 存在；`CFBundleIconFile=icon.icns` |
| `release/SqlDiff-0.1.0-arm64.dmg` | 115M | mac arm64 | `hdiutil verify` → VALID；`release/mac-arm64/SqlDiff.app/Contents/MacOS/SqlDiff` 为 arm64；包内 `icon.icns` 存在 |
| `release/SqlDiff Setup 0.1.0.exe` | 99M | win x64 nsis | `file` 识别为 NSIS PE；`release/win-unpacked/SqlDiff.exe` 为 PE32+ x86-64；解析 `.rsrc` 的 `RT_GROUP_ICON` 得到 6 个 32bpp PNG（16/32/48/64/128/256） |
| `release/win-unpacked/SqlDiff.exe` | 182M | win x64 | 存在；未在 Windows 真机启动（macOS 交叉构建限制） |

签名状态：mac/win 均**未签名**（无 Developer ID / 代码签名证书），属预期；公证与签名需另立任务。
打包命令：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run pack`（镜像仅用于绕过 GitHub 下载 EOF）。
