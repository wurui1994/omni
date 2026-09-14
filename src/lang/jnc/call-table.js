// src/lang/jnc/call-table.js —— **调用**那一族的分派次序
//
// 从旧降级 `callExpr`（`frontend-jnc/lower.js:14723-14830`）整块读出来。一次调用的差别全在
// **被调那一侧**，所以这一层是一张有次序的表：谁排在谁前面决定了"遮挡"与"静态绑定"对不对。
// 每格带出处与拼法。

/**
 * 按这个次序问，第一格命中就是它：
 *
 *  1. **`$"…"(a, b)` 那对括号不是调用**（第六十四刀）：它是格式化字面量自己的实参表
 *     （Expr.llk:940 把它挂在 literal 上），语法这一层落成了一次调用，所以先认出来；
 *  2. **从一格函数指针上调**（第五十五刀）：`p(…)` 里 `p` 是变量而不是函数名 → `(callfn …)`。
 *     **要排在按名字找函数之前** —— 同名的局部量**遮住**模块级那个函数；
 *  3. 被调**可以是限定名**（`a.f()`，第五十一刀）：它在表达式里是一串取字段，**整串摊得动**
 *     才算限定名；摊不动才是"取字段再调"（那一条还不收）；
 *  4. `printf` 的返回值当值用：不收（它在这一层是方言的 `print`，没有返回值）；
 *  5. **方法体里裸写基类的方法**（第五十六刀）：类是一层命名空间，可**基类不是这一层的外层**
 *     —— 按命名空间前缀走走不到基类那条链上，所以要沿继承链再问一遍；
 *  6. **`basetype.foo()` / `basetype.construct(…)` 是静态绑定的**（第五十六刀，
 *     type_class.rst:226/253）：说的就是"调基类那一个"，所以**不过分派那一格**，名字直接沿链取。
 *     这一问要排在方法调用**之前** —— `basetype` 不是一格值，求它会报错。基类那格 `construct`
 *     **在宿主那边**时发 `(ccall Base_construct $this 实参…)`，默认值/C_ABI/variant 那几条与
 *     `new C(…)` 走**同一份**（第一百九十二刀 + 第一百六十二刀）；
 *  7. **`x.basetype.m(…)`**（第一百二十七刀）：跟在**点后面**的那一格 basetype —— 拿左边那个
 *     对象的基类那一面调（`p.m_bucket.basetype.remove(…)`），用处是"绕过派生类的遮挡"。
 *     与写在方法体里的 `basetype.m(…)` 是同一件事，只是 `this` 换成左边那个值；一条继承链
 *     共用**一格**方言结构体（第五十六刀），所以"换一面"发的是**零条指令**；
 *  8. **方法调用**（第五十二刀）：`c.foo(…)` 就是 `C$foo(c, …)` —— 对象当第一个实参。
 *     只在"名字这一层查不着、而 `.` 右边那个名字确实是某个类的方法"时才去求左边的值 ——
 *     免得给"真的没有这个函数"多发一条诊断；
 *  9. 都不是：按被调那一格的形状拆成四件事各自说清（第二百二十刀）——`typeof(T).m(…)` 要反射
 *     那张表、等等。
 */
export const CALL_ORDER = [
  { name: 'fmt-literal', why: '`$"…"(a, b)` 那对括号是格式化字面量的实参表，不是调用' },
  { name: 'fn-ptr', why: '从函数指针上调 → `(callfn …)`；**要排在按名字找函数之前**（局部量遮住模块级）' },
  { name: 'qualified', why: '限定名 `a.f()`（整串摊得动才算）' },
  { name: 'printf-value', why: '`printf` 的返回值当值用：不收' },
  { name: 'base-method-bare', why: '方法体里裸写基类的方法 —— 要沿继承链再问一遍' },
  { name: 'basetype-static', why: '`basetype.foo()` 静态绑定，不过分派；要排在方法调用之前' },
  { name: 'dot-basetype', why: '`x.basetype.m(…)`：拿左边那个对象的基类那一面调（换一面发零条指令）' },
  { name: 'method', why: '`c.foo(…)` → `C$foo(c, …)`；只在"右边确实是方法"时才求左边的值' },
  { name: 'other', why: '剩下四件事各自说清（第二百二十刀）' },
];

/** 普通函数：`(call 名字 实参…)`。 */
export function callText(sym, args) {
  return `(call ${sym}${args.map((a) => ` ${a}`).join('')})`;
}

/** 方法：**对象当第一个实参**（第五十二刀）。 */
export function methodCallText(sym, selfCode, args) {
  return `(call ${sym} ${selfCode}${args.map((a) => ` ${a}`).join('')})`;
}

/** 从一格函数指针上调（第五十五刀）：那一格值自己就是被调。 */
export function callThroughText(fnCode, args) {
  return `(callfn ${fnCode}${args.map((a) => ` ${a}`).join('')})`;
}

/** 宿主那边的函数（`with "h.h"` 收来的、opaque 的方法、基类在宿主的 construct）：`(ccall …)`。 */
export function ccallText(sym, args) {
  return `(ccall ${sym}${args.map((a) => ` ${a}`).join('')})`;
}
