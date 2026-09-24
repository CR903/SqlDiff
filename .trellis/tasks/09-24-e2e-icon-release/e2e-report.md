# E2E 全面测试报告

日期：2026-09-24 · 平台：macOS（darwin x64）· 被测：apps/desktop v0.1.0（commit f83f91c + 图标改动）
方法：Electron `--remote-debugging-port=9333` + CDP（`Runtime.evaluate` 读状态、`Input.dispatchMouseEvent` **可信点击**、`Page.handleJavaScriptDialog` 处理 confirm、剪贴板/文件实证）
证据：`evidence/*.png`（本目录）

## 测试环境

- 真库：Docker `mysql:8.0`（127.0.0.1:3307），fixture `e2e_src`(A) vs `e2e_tgt`(B)
  - 结构差异：users（缺 age 列 + 2 个索引）、only_in_src（仅A）、only_in_tgt（仅B）、v_src_view/v_tgt_view
  - 数据差异：buildings（A1行/B3行，含同 key 改值）、pair_kv（**联合主键** A2/B2）、no_pk_table（**无主键**）、users（0/0）
- 说明：用户内网库 `192.168.0.5` 与阿里云 RDS 当日均不可达（EHOSTUNREACH / timeout），改用 Docker 造等价 fixture，覆盖面更可控且可复现。

## 用例结果

| # | 用例 | 结果 | 关键证据 |
|---|------|------|----------|
| T1 | 冷启动：标题/三栏/空状态 | ✅ | `t1-cold-start.png` |
| T2a | 新增弹窗空校验（必填拦截） | ✅ | `t2-new-conn-fail.png` |
| T2b | 填表 → 测试连接失败（中文结构化，无 `Error invoking`） | ✅ | toast `连接失败 [MYSQL_CONNECT] … ECONNREFUSED` |
| T2c | 保存 → 下拉出现 + 左侧「全部」可见 | ✅ | `t2-after-save.png` |
| T2d | 落盘：meta 入 nodes.json、密钥 safeStorage 加密、无明文 | ✅ | provider=`safestorage` |
| T2e | 编辑：预填 + 分组持久化 + 密码留空不动 | ✅ | `groupPersisted=true` |
| T2f | 删除：confirm → 左侧/下拉消失 + nodes.json/密钥清理 | ✅ | `t2-after-delete.png` |
| T3a | demo 兜底对比（种子节点）+ 错误消毒 | ✅ | `t3a-demo.png` |
| T3b | 真库节点连接测试（Docker MySQL） | ✅ | `t3c-nodes.png` |
| T3c | **真库结构对比**：7 条差异（CREATE2/DROP2/CHANGE3） | ✅ | `t3d-struct.png` |
| T4a | 对象 chip 多选（只看表 5/7，取消复原 7） | ✅ | `t3d-chip-table.png` |
| T4b | 动词 chip 多选（DROP 桶） | ✅ | `t3d-drop-copy.png` |
| T5a | **真库数据对比**：4 表处理，I1/D3/U2 | ✅ | `t5-data-only.png` |
| T5b | 联合主键（pair_kv）WHERE `region`+`code` 正确 | ✅ | `t5c-chinese-update.png` |
| T5c | 无主键表跳过 + 精确原因 + 替代策略 | ✅ | 状态行 `无可用行身份…加主键（或全列 NOT NULL UNIQUE）` |
| T5d | 中文端到端：`塔楼A中文` 读取/展示/复制无乱码 | ✅ | 见下方备注 |
| T6a | 导出落盘：文件存在、头注释、条数=列表 | ✅ | `sqldiff_*.sql` items=rows |
| T6b | 0 条导出：不产生文件 | ✅ | `noFileOnEmpty=true` |
| T7 | 密钥安全复核：4 个 secret 文件全 safeStorage，无明文 | ✅ | — |
| T8a | 交换 A/B | ✅ | `swapWorked=true` |
| T8b | Cmd+Enter 快捷键触发对比（2→13 条） | ✅ | `t8-smoke.png` |
| T8c | 节点搜索过滤 | ✅ | hit=1 |

**结论：22/22 通过，未发现应用侧缺陷。**

## 备注与观察（非缺陷）

1. **fixture 编码插曲**：首次 fixture 用 `docker exec -i mysql`（客户端默认 latin1）灌入中文，导致库里存的是双重编码字节（HEX `C3A5C2A1…`），应用读出来自然也是 `å¡”æ¥¼`。用 `--default-character-set=utf8mb4` 重灌后应用端到端显示 `塔楼A中文` 正常。**应用读写路径无问题**，是测试数据构造问题。
2. **空结果导出提示**：0 条时预览区显示占位文案「暂无 SQL — 先对比…」，而不是 toast「暂无可导出 SQL」（按钮在 0 条时已提前 return，toast 分支不可达）。行为正确（无文件产生），仅提示位置可优化。
3. **真实对比失败会降级为 demo 示例数据**：当节点不存在/连接失败时，UI 会用本地示例数据填充并 toast 说明原因（`后端对比失败，已用本地示例数据演示（原因）`）。功能上可演示，但对真实用户可能造成「以为拿到了真实差异」的误读——建议后续在降级态给明显的视觉标识（如结果区顶部黄色「示例数据」横幅）。属产品决策，未改。
4. **远程库不可达**：内网 `192.168.0.5` 与阿里云 RDS 当日网络不通（9/22 可达），真库验证改用 Docker fixture；SSH 单跳真机验证仍待用户提供可达节点+密钥。

## 环境清理

- Docker 容器 `sqldiff-e2e-db`（测试后已 `docker rm -f`）
- 应用 user-data 中的 e2e 节点/密钥已通过 UI 删除路径清理
- 测试 harness 全部在 `$TMPDIR`，未入库

---

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
| `release/SqlDiff-0.1.0.dmg` | 119M | mac x64 | `hdiutil verify` → VALID；挂载出 `SqlDiff.app`；`Contents/Resources/icon.icns` 存在；`CFBundleIconFile=icon.icns` |
| `release/SqlDiff-0.1.0-arm64.dmg` | 115M | mac arm64 | `hdiutil verify` → VALID；arm64 包内 icon.icns 存在 |
| `release/SqlDiff Setup 0.1.0.exe` | 99M | win x64 nsis | PE32+ GUI x86-64；builder 从 `build/icon/icon.ico` 嵌入 |
| `release/win-unpacked/SqlDiff.exe` | — | win x64 | 存在（未签名） |

签名状态：mac/win 均**未签名**（无 Developer ID / 代码签名证书），属预期；公证与签名需另立任务。
打包命令：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run pack`（镜像仅用于绕过 GitHub 下载 EOF）。
