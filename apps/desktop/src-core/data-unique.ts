// 小增强 R1：UNIQUE 等价行身份（实现收敛于 data-pk.ts，此处重导出以兼容双路径引用）。
export { isColumnNotNull, parseTablePK, parseUniqueKeys, qualifyIdentity } from './data-pk';
export type { TableIdentity, UniqueKeyDef } from './data-pk';
