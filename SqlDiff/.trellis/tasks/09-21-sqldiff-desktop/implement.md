# Implement — sqldiff-desktop

## Checklist

- [ ] M1 工程骨架：Electron+Vite+React+TS+Zustand+Monaco+sql-formatter，`electron-builder` Win(nsis)+mac(dmg, arm64/x64)，CI打双包。
- [ ] M2 存储vault：safeStorage+keychain，nodes.json/history.json，约定加密导出/导入解码，连接串导入器。
- [ ] M3 连接层：mysql2/promise + ssh2单跳（密码+密钥），test+延迟，隧道复用/关闭。
- [ ] M4 diff移植：port diffTable/diffTableField/diffProcedure/filter系 → core TS + 单测（CREATE/DROP/CHANGE各3例）。
- [ ] M5 UI三栏：NodeLibrary（历史/我的/常用+拖拽）/ CompareSlots（swap+scope+表过滤+进度）/ DiffTable+SqlPreview（Tab过滤+复制/导出.sql+DROP警示+风险/回滚）。
- [ ] M6 HTML mock原型先行（无ui-ux-pro-max期间），后补高保真。
- [ ] M7 打包验证：离线对比、双端冒烟（AC1-AC8）。

## Validation

- `npm run typecheck && npm run lint`
- `npm test -- core/diff`（覆盖表新增/缺列/改列/主键/索引；过程新增/删除/变更；视图OR REPLACE）
- 手工：双本地库对比 → 检查四Tab数量与复制内容一致；DROP二次确认；导出→删库→导入恢复免密。
- `electron-builder --win --mac` 双包成功。

## Risky files / rollback

- `main/tunnel.ts`（ssh2端口冲突→随机本地端口+关闭复用）。
- `core/diff.ts`（沿用老正则，勿改语义；改前先加单测）。
- `storage/vault.ts`（密钥丢则导出不可解→启动自检+备份提示）。
- 回滚：本任务只新增 `apps/desktop/`，不动 `mysqldiff/` 老代码；失败删新目录即可。

## Gates before start

- prd/design/implement已评审；`implement.jsonl`/`check.jsonl` 待配（start前补）。
