// src/core/graph/types.js —— **节点图的类型覆盖层**（#40 第一步：先把 core 那一份抽出来）
//
// ## 这一份是什么
//
// 图上**没有类型**（`nodes.js` 文件头第一条：type 不是节点）。可下游有三处要类型：
// core 那条腿要（方言是有类型的）、wat 那条腿要（i64 与 f64 分得开）、c 那条腿要
// （能不能当 double 直接算）。三处各写了一份，口径已经不一样 —— 这一份就是那个
// "问同一个地方"（`docs/design/node-graph-typed-overlay.md` 第一节量的两笔账）。
//
// ## 这一步只做一件事：**原样搬**
//
// 这一批是设计里的第一步："把 core 的 `typeOf` 那一套原样搬进来，core 改成调它，
// **产出必须逐字节相同**"。所以这一份里**没有一行新逻辑** —— 连"查不到当 int"那几处
// （设计里判据三要治的那 9 处 `?? 'int'`）都照旧留着，那是下一批的事。
// 一次只动一件事：这一步动的是"住在哪儿"，不是"答什么"。
//
// ## 与调用方的那格约定（`ctx`）
//
// 推断要问两件图上没有的事，都由调用方交（这一格就是设计里说的"种子由映射交"的雏形 ——
// 现在的种子来自 core 自己的登记处，以后从 `opts.hints` 来）：
//
//   ctx.shapes            标签 -> 形状（记录 / 多值），`Map`
//   ctx.shapeOf(names, types, multi)   登记一格形状，回那一份（core 那侧顺带印 `(struct …)`）
//   ctx.gap(why)          报一格**有名有姓**的缺口（抛，不回）—— 措辞归调用方那条腿，
//                         所以这一层不自己拼"core 这条腿还没接"那句话
//
// 为什么 `shapeOf` 与 `gap` 是**传进来的**而不是这儿写：前者要往产物头上印一句
// `(struct rN …)`（那是方言的文本，不是类型），后者的措辞里带着"哪条腿" ——
// 两样都是**后端的事**。这一层只答"这格是什么类型"。

const isNode = (x) => x !== null && x !== undefined && x.op !== undefined;
const isLit = (x) => x !== null && x !== undefined && x.lit !== undefined;

export { isNode, isLit };

/** 一格 `rest` 端口收成数组（图上一格与一串两种写法都有）。 */
export function argList(n, port) {
  const x = n.ins[port];
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/** 一格字面量的类型。推不出来回 null（调用方报缺口）。 */
export function litType(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'real';
  return null;
}

/**
 * **与实参无关的那几格内建的类型**（比较出 bool、`len` 出 int、`concat` 出串、
 * `push` 是语句所以 null）。别的内建（算术）要看实参，不在这张表里 —— 回 undefined。
 *
 * 为什么单抽一格：这张表原来在 `typeOf` 与 `retTypeOf` 里**各写了一份**，而后者写漏了
 * （只有"比较出 bool、别的出 int"），于是"函数返回一格 `concat`"被说成返回 int ——
 * go 的 `fmt.Sprintf` 那一族撞出来的。`retTypeOf` 不能直接调 `typeOf`：它**跑得早**
 * （形状还没登记全），问算术那一档会报缺口。所以两处共用的是这张**只管固定那几格**的表。
 */
export function primFixedType(nm) {
  if (nm === '<' || nm === '>' || nm === '<=' || nm === '>=' || nm === '=' || nm === '!=' || nm === 'not') return 'bool';
  if (nm === 'len') return 'int';
  if (nm === 'band' || nm === 'bor' || nm === 'bxor' || nm === 'bnot'
    || nm === 'shl' || nm === 'shr') return 'int';   // 位运算只对整数，答案也是整数
  if (nm === 'concat') return 'string';
  if (nm === 'push') return null;      // 语句，没有值
  return undefined;                    // 要看实参
}

/** `(arr T)` 的元素类型。不是数组回 null。 */
export function elemType(t) {
  if (typeof t !== 'string' || !t.startsWith('(arr ')) return null;
  return t.slice(5, -1);
}

/** `(dict K V)` 的键与值。不是字典回 null。 */
export function dictOf(t) {
  if (typeof t !== 'string' || !t.startsWith('(dict ')) return null;
  const two = t.slice(6, -1).split(' ');
  if (two.length !== 2) return null;
  return { key: two[0], val: two[1] };
}

/** 这一格类型是不是标量（记录 / 列表 / 字典的元素只收这四格）。 */
export const isScalar = (t) => t === 'int' || t === 'real' || t === 'bool' || t === 'string';

/** 一格 `conv` 的目标是哪个类型。不认的那一格当场报。 */
export function convTo(x, ctx) {
  const to = x.attrs.to;
  if (to === 'int') return 'int';
  if (to === 'float') return 'real';
  if (to === 'str') return 'string';
  return ctx.gap(`这格表示转换还没接：to=${to}`);
}

/**
 * **"不知道"那一格**（设计里判据三的核心）。推不出来就是它 —— 不是 int。
 *
 * 为什么要有名字：原来这一份里有 **9 处** `?? 'int'`（字面量 · const · ref · 调用的返回 ·
 * 下标的元素 · pick 的第 k 格 · map-get 的值 · 兜底那一格 · 形参），查不到就当 int。
 * 那是**猜**，而且咬过两次（`retTypeOf` 把串接说成 int、把 match 说成 int，两次都是
 * 下游当场骂一句错误，而不是一格有名有姓的缺口）。现在那 9 处一律答 `unknown`，
 * 而"当 int"**只剩 `typeOf` 里那一处**（那一处是 core 这条腿今天的口径，还没治 ——
 * 但它从"到处都在猜"变成了"一处在猜"，而且有判据数着，见 `tests/graph/types.js`）。
 */
export const UNKNOWN = 'unknown';

/**
 * 一格**表达式**的类型 —— **推不出来就答 `unknown`**（不猜）。
 *
 * 名字的类型从 `env`（名字 -> 类型）里查。`ctx` 是那格登记处（形状表 + `shapeOf` + `gap`，
 * 见文件头）—— 它不能住在 `env` 里：`env` 逢作用域就 `new Map(env)` 复制一份，
 * 而形状是模块级的。
 *
 * 三处**故意不往下传 `unknown`**（都用下面那个"当 int"的 `typeOf`）：`values` 的元素类型
 * （要拿它登记形状、印进产物文本）、`field-get`（形状查不着要报缺口）、`pick` 的宿主
 * （拿它去形状表里查）。这三处要的是"落成什么"，不是"推出什么"。
 */
export function inferType(x, env, ctx) {
  if (isLit(x)) return litType(x.lit) ?? UNKNOWN;
  if (!isNode(x)) return UNKNOWN;
  if (x.op === 'const') return litType(x.attrs.value) ?? UNKNOWN;
  if (x.op === 'ref') return env.get(x.attrs.name) ?? UNKNOWN;
  if (x.op === 'prim') {
    const nm = x.attrs.name;
    const fixed = primFixedType(nm);
    if (fixed !== undefined) return fixed;
    /* 算术：串在一起是 `string`、任一边是 real 就 real（方言里 int 与 real 不隐式混算 ——
       混着写它当场报，那正是我们要的：与 ADR-0031 §1 那一格"位宽写在类型上"同一条纪律）。
       有一边推不出来，结果就**也推不出来** —— 原来这儿一律当 int。 */
    const ts = argList(x, 'args').map((a) => inferType(a, env, ctx));
    if (ts.some((t) => t === 'string')) return 'string';
    if (ts.some((t) => t === 'real')) return 'real';
    if (ts.some((t) => t === UNKNOWN)) return UNKNOWN;
    return 'int';
  }
  if (x.op === 'call') {
    const f = x.ins.fn;
    const nm = isNode(f) && f.op === 'ref' ? f.attrs.name : null;
    return (nm !== null ? env.get(`fn:${nm}`) : null) ?? UNKNOWN;
  }
  if (x.op === 'branch') return inferType(x.ins.then, env, ctx);
  if (x.op === 'field-get') return fieldType(x, env, ctx);
  if (x.op === 'index-get') return elemType(inferType(x.ins.obj, env, ctx)) ?? UNKNOWN;
  if (x.op === 'map-get') {
    const d = dictOf(inferType(x.ins.obj, env, ctx));
    return d === null ? UNKNOWN : d.val;
  }
  if (x.op === 'map-has') return 'bool';
  if (x.op === 'values') return multiShape(argList(x, 'args'), env, ctx).tag;
  if (x.op === 'pick') {
    const shape = ctx.shapes.get(typeOf(x.ins.from, env, ctx));
    if (shape === undefined) return UNKNOWN;
    return shape.types.get(`v${Number(x.attrs.index ?? 0)}`) ?? UNKNOWN;
  }
  if (x.op === 'conv') return convTo(x, ctx);
  return UNKNOWN;
}

/**
 * 同一问，**答案里不许有 `unknown`**：推不出来的一律当 `int`。
 *
 * 这一处就是判据三还没治的那**一格猜**（原来是 9 处）。为什么这一批不治：改它会动
 * core 那条腿的产物（"形参默认 int"是它今天的口径），而这一步的验收标准是**逐字节相同**。
 * 治它的次序写在 `docs/design/node-graph-typed-overlay.md` 第六节第五步。
 */
export function typeOf(x, env, ctx) {
  const t = inferType(x, env, ctx);
  return t === UNKNOWN ? 'int' : t;
}

/**
 * 一格 `values`（`return a, b`）落成的那格形状：字段就叫 `v0` / `v1` …
 *
 * 为什么是结构体而不是别的（core 那侧）：方言的函数**只交一格回来**，而结构体是**值语义**的
 * （赋值/传参/返回都复制，见 tests/sexpr/cases/06-structs.sx）—— 那正好就是多值的语义。
 */
export function multiShape(vals, env, ctx) {
  const types = vals.map((v) => typeOf(v, env, ctx));
  for (const t of types) if (!isScalar(t)) ctx.gap(`多值里有一格不是标量（量到的是 ${t}）`);
  return ctx.shapeOf(types.map((_, i) => `v${i}`), types, true);
}

/** 一格 `field-get` 交出来的类型：宿主的形状表里查那个字段。查不到当场报。 */
export function fieldType(x, env, ctx) {
  const t = typeOf(x.ins.obj, env, ctx);
  const shape = ctx.shapes.get(t);
  if (shape === undefined) ctx.gap(`在一格说不清形状的东西上取字段 '${x.attrs.field}'`);
  const ft = shape.types.get(x.attrs.field);
  if (ft === undefined) ctx.gap(`记录 ${t} 上没有字段 '${x.attrs.field}'`);
  return ft;
}

/**
 * **只看字面量的那一档类型**（`retTypeOf` 用它 —— 那一趟跑得早，问不了 env 与形状）。
 *
 * 为什么要它：V 与 go 的**串接也写成 `+`**（`'a' + 'b'`、`@STRUCT + '.' + @FN`），
 * 而 `+` 的类型"要看实参"。原来这一趟一律当 int，于是"函数返回一格串接"被说成返回 int，
 * 方言当场骂"要返回 int，给的是 string" —— 那是**一句错误，不是一格有名有姓的缺口**。
 * 这张表只顺着字面量与固定那几格往下看（不查名字，所以早跑也安全）：推不出来回 null。
 */
export function litLeaningType(x) {
  if (isLit(x)) return litType(x.lit);
  if (!isNode(x)) return null;
  if (x.op === 'const') return litType(x.attrs.value);
  /* **表达式位置上的 branch**（V 的 `match` 当表达式用就落成它）：两支同型，看一支就够。
     漏了这一条的代价量过：`fn kind(c) string { return match c { … } }` 被说成返回 int，
     方言当场骂"要返回 int，给的是 string" —— 又是一句错误而不是一格有名有姓的缺口。 */
  if (x.op === 'branch') return litLeaningType(x.ins.then);
  if (x.op !== 'prim') return null;
  const fixed = primFixedType(x.attrs.name);
  if (fixed !== undefined) return fixed;
  const ts = argList(x, 'args').map(litLeaningType);
  if (ts.some((t) => t === 'string')) return 'string';
  if (ts.some((t) => t === 'real')) return 'real';
  return null;
}

/** 一格函数体里 `ret` 交出来的类型（只看第一处 —— 这一刀不做合一）。一格都没有回 null。 */
export function retTypeOf(body, env, ctx) {
  const seek = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) { const t = seek(y); if (t !== null) return t; }
      return null;
    }
    if (!isNode(x)) return null;
    if (x.op === 'ret') {
      const v = x.ins.value;
      if (v === undefined || v === null) return 'void';
      if (isLit(v)) return litType(v.lit);
      if (isNode(v) && v.op === 'const') return litType(v.attrs.value);
      /* 多值：交回去的是那格合成结构体（登记在这儿 —— 调用点要靠它定型）。 */
      if (isNode(v) && v.op === 'values') return multiShape(argList(v, 'args'), env, ctx).tag;
      /* 先问那张"只看字面量"的表（prim 之外还认 branch —— 见 litLeaningType）。 */
      {
        const t = litLeaningType(v);
        if (t !== null) return t;
      }
      if (isNode(v) && v.op === 'prim') {
        /* 与实参无关的那几格查**共用的那张表**（`primFixedType`）—— 原来这儿重抄了一份
           且写漏了 `concat`，于是"函数返回一格 concat"被说成返回 int（go 的 `fmt.Sprintf`
           那一族撞出来的）。**不能直接调 `typeOf`**：这一趟跑得早，形状还没登记全，
           问算术那一档会报缺口（method 那一族当场红过）。要看实参的走 `litLeaningType`
           （只顺着字面量看 —— V 的 `'a' + 'b'` 那一族撞出来的，见那一格的注）。 */
        return litLeaningType(v) ?? 'int';
      }
      return 'int';
    }
    for (const k of Object.values(x.ins)) { const t = seek(k); if (t !== null) return t; }
    return null;
  };
  return seek(body);
}
