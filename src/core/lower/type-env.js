// src/core/lower/type-env.js —— 公共降级器的类型环境（ADR-0044）
//
// 所有语言共用的类型注册/查找/别名机制。
// 从 src/lang/jnc/emit-ctx.js + resolve-type.js 提取公共部分。

/**
 * 类型环境。管理类型名 → 类型描述的映射。
 *
 * 用法：
 *   const env = new TypeEnv();
 *   env.register('Point', { kind: 'struct', fields: [...] });
 *   env.alias('Pt', 'Point');
 *   env.lookup('Pt');  // → { kind: 'struct', fields: [...] }
 */
export class TypeEnv {
  constructor() {
    /** @type {Map<string, any>} 类型名 → 类型描述 */
    this.types = new Map();
    /** @type {Map<string, string>} 别名 → 原名 */
    this.aliases = new Map();
    /** @type {Map<string, any>} 函数签名：名字 → { params, ret } */
    this.funcs = new Map();
    /** @type {Map<string, any>} 结构体字段表：类型名 → [{ name, type }] */
    this.fields = new Map();
  }

  /** 注册一个类型。 */
  register(name, desc) {
    this.types.set(name, desc);
  }

  /** 给一个类型起别名。 */
  alias(alias, original) {
    this.aliases.set(alias, original);
  }

  /** 查找类型（穿透别名）。 */
  lookup(name) {
    const real = this.aliases.get(name) ?? name;
    return this.types.get(real) ?? null;
  }

  /** 注册函数签名。 */
  registerFunc(name, sig) {
    this.funcs.set(name, sig);
  }

  /** 查找函数签名。 */
  lookupFunc(name) {
    return this.funcs.get(name) ?? null;
  }

  /** 注册结构体字段。 */
  registerFields(typeName, fieldList) {
    this.fields.set(typeName, fieldList);
  }

  /** 查找结构体字段。 */
  lookupFields(typeName) {
    const real = this.aliases.get(typeName) ?? typeName;
    return this.fields.get(real) ?? null;
  }

  /** 有没有这个类型（用于"是类型还是变量"的判断）。 */
  hasType(name) {
    const real = this.aliases.get(name) ?? name;
    return this.types.has(real);
  }
}

/**
 * 基本类型表。所有 C 系语言都有这些。
 * 语言的 adapter 可以用 `{ ...BASIC_TYPES, ...languageSpecificTypes }` 来扩展。
 */
export const BASIC_TYPES = {
  void: { kind: 'void' },
  bool: { kind: 'bool' },
  int: { kind: 'int', w: 32, u: false },
  uint: { kind: 'int', w: 32, u: true },
  int8: { kind: 'int', w: 8, u: false },
  uint8: { kind: 'int', w: 8, u: true },
  int16: { kind: 'int', w: 16, u: false },
  uint16: { kind: 'int', w: 16, u: true },
  int32: { kind: 'int', w: 32, u: false },
  uint32: { kind: 'int', w: 32, u: true },
  int64: { kind: 'int', w: 64, u: false },
  uint64: { kind: 'int', w: 64, u: true },
  real: { kind: 'real' },
  double: { kind: 'real' },
  float: { kind: 'real' },
  string: { kind: 'string' },
  char: { kind: 'int', w: 8, u: true },
};
