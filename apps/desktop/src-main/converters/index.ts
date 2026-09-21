// converters/ 预留：二期 DBeaver / DataGrip 等第三方连接配置导入。
//
// 首版导出仅自定义 JSON（见 ../src-core/types.ts ExportJSON，密码走 AES-GCM 约定加密段）。
// 二期在此目录按 `NodeConverter` 接口实现第三方格式 → { meta, secret } 的转换，
// 再经 Vault.saveNodeSecret + saveNodes 落盘。本文件只定接口，不做任何 IO。

import type { NodeMeta, SecretBundle } from '../../src-core/types';

/** 第三方单节点转换结果：元数据 + 明文秘密（调用方负责经 vault 加密落盘，永不写明文文件）。 */
export interface ConvertedNode {
  meta: Omit<NodeMeta, 'id' | 'createdAt'> & { id?: string; createdAt?: string };
  secret: SecretBundle;
}

/** 转换器接口：二期实现 `fromDBeaver` / `fromDataGrip` 等并在此注册。 */
export interface NodeConverter {
  /** 转换器名（如 'dbeaver'），用于日志与错误提示。 */
  readonly name: string;
  /** 探测输入是否为本转换器可处理（不抛异常，返回布尔）。 */
  canHandle(input: unknown): boolean;
  /** 转换（输入非法时抛 Error，message 面向 UI 直显中文）。 */
  convert(input: unknown): ConvertedNode[];
}

/** 二期转换器注册表（首版为空，保留注册入口）。 */
export const converters: NodeConverter[] = [];

export function registerConverter(c: NodeConverter): void {
  if (!c || typeof c.name !== 'string' || typeof c.convert !== 'function') {
    throw new Error('converters: 非法转换器');
  }
  converters.push(c);
}
