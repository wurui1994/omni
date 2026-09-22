// src/core/lower/ty.js —— **标准 IR 的类型描述 → .sx 类型文本**（ADR-0044）
//
// 单开一份的理由是依赖方向：语句层（`lower-stmt.js` 的 `let`）与主入口（`lower.js` 的
// 函数签名、struct、global）都要它，而那两份里主入口 import 语句层 —— 放在主入口里就成了环。
//
// 语言自己的类型（jnc 的位域、go 的 slice/chan、V 的 Option）由 `hooks.typeToSx` 先答；
// 它回 null 就落到这张公共表上。**这一层不推导类型**（方言那一侧也不推导，只检查）——
// 类型是 adapter 放进标准 IR 里的。

import * as sx from './sx.js';

/**
 * 类型描述 → .sx 类型文本。
 *
 * @param {object|string|null} type  标准 IR 的类型描述（§1.2 的 `{ kind: … }`）
 * @param {object} hooks             语言钩子（`typeToSx` 可以先答）
 * @returns {string}                 .sx 类型文本
 */
export function typeToSx(type, hooks = {}) {
  if (type === null || type === undefined) return 'void';
  if (typeof type === 'string') return type;
  if (hooks.typeToSx) {
    const r = hooks.typeToSx(type);
    if (r !== null && r !== undefined) return r;
  }
  switch (type.kind) {
    case 'void': return 'void';
    case 'bool': return 'bool';
    case 'int': return 'int';
    case 'real': return 'real';
    case 'string': return 'string';
    /** 真动态那一档（lua / awk / Python 那一族里"运行期才知道装的是什么"）。 */
    case 'dyn': return 'dyn';
    case 'named': return type.name;
    case 'ptr': return sx.ptr(typeToSx(type.inner, hooks));
    case 'arr': return `(arr ${typeToSx(type.elem, hooks)})`;
    case 'map': return sx.dict(typeToSx(type.key, hooks), typeToSx(type.value, hooks));
    case 'fn-type': {
      const ps = type.params.map((p) => typeToSx(p, hooks)).join(' ');
      return `(fnty (${ps}) ${typeToSx(type.ret, hooks)})`;
    }
    default: return type.name ?? 'void';
  }
}

/**
 * 一格类型的**零值**（.sx 文本）。awk / go 那一族"声明就有初值"的语言要它 ——
 * awk 里没赋过值的量当数是 0、当串是 ""，正好都是零值。
 * 语言的 `hooks.zeroOf` 可以先答（自己的类型要自己给零值）。
 */
export function zeroOf(type, hooks = {}) {
  if (hooks.zeroOf) {
    const r = hooks.zeroOf(type);
    if (r !== null && r !== undefined) return r;
  }
  const t = typeof type === 'string' ? { kind: type } : (type ?? { kind: 'void' });
  switch (t.kind) {
    case 'bool': return sx.bool(false);
    case 'int': return sx.int(0);
    case 'real': return sx.real(0);
    case 'string': return sx.str('');
    case 'map': return sx.dnew(typeToSx(t, hooks));
    /* 具名的记录：**引用语义造 `cnew`、值语义造 `new`**。
       `if` 当表达式用而两支交的是一格记录时要它（`values.lisp` 量出来的）。 */
    case 'named': return t.ref === true ? sx.cnew(t.name) : sx.newVal(t.name);
    /* 函数值那一格：零值是一格空的函数值（go 的 `var f func()` / 接口里那几格方法闭包）。 */
    case 'fn-type': return sx.nullFn(typeToSx(t, hooks));
    default:
      throw new Error(`lower/ty.js: ${typeToSx(t, hooks)} 这一格还没有零值 —— `
        + '要么在这张表上加一格，要么由 hooks.zeroOf 答');
  }
}
