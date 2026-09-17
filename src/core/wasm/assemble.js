// src/core/wasm/assemble.js —— **WAT 文本 -> wasm 二进制**（就为了能交给一个真引擎跑）
//
// 这一份的来由是一笔记了很久的账：图那条 wat 腿的正确性一直由 `frontend-wat` + MIR 解释器
// 证 —— 那是一条**互不相干的实现**，可它仍然在这棵树里。"wasm 必须是后端"这句话要立得住，
// 那份 `.wat` 得让**外面的引擎**认。写这段的机器上没有 wabt / wasmtime，
// 但 Node 自带 V8，而 V8 里那台 wasm 引擎与这棵树没有半点关系 ——
// 缺的只是"文本 -> 二进制"这一步，于是补这一份。
//
// ## 收哪些（明说，不假装是个通用汇编器）
//
//   模块层：`(module)` `(import "omni" "…" (func $id (param T)…(result T)?))` `(memory N M?)`
//           `(global $id (mut T)? (expr))` `(data (i32.const N) b0 b1 … | "串")`
//           `(func $id (export "n")? (param …)… (result T)? (local …)… body…)`
//           `(export "n" (func $id) | (memory 0))` `(start $id)`
//           `(type $sig (func …))` `(table N funcref)` `(elem (i32.const N) $a $b …)`
//   指令层：折叠写法（`(i64.add (local.get $a) (i64.const 1))`）· `block` / `loop` /
//           `if`+`then`/`else` · `br` / `br_if`（名字或深度）· `return` · `call` · `drop`
//           · `call_indirect`（`(type $sig)` 与**内联签名**两种写法）
//           · `memory.size` / `memory.grow` · 访存那一族（`align=` / `offset=` 都收）
//           · 下面 `WASM_OPS` 那张表里的算子
//
// 两处语料决定了这张表有多大：**后端真发过的**（`grep` 出来的）与 `tests/wat/cases/*.wat`
// 那几份**给前端写的夹具**（块注释、十六进制、数字下标、`local.tee`、`(start …)`、
// 内存上下界、串转义 `m\61in` …… 后端一条都不发）。收下后者的理由是它换来一条**反向**判据：
// 同一份夹具，MIR 那条路与 V8 两边输出逐行相同 —— 前端读错了才咬得住（见 tests/graph/wasm.js）。
//
// `table` / `elem` / `call_indirect` **已经收了**（"函数当值用"那条账付掉之后，两侧都在发
// 这种形状）· 没有 `table.set` 那一族（表在这条路上是常量，前端正是靠这一条把
// `call_indirect` 化开的）· 没有 `select` / 位运算里那几格没人发过的。
// **发到没见过的东西就当场报错**，不许猜着编：编出一份 V8 拒收的二进制，错会指到最没关系的
// 地方（V8 只会说 invalid section）。
//
// 判据在 `tests/graph/wasm.js`：那 76 份例子的 `.wat` 逐个装出二进制、交给
// `WebAssembly.instantiate` 跑，输出与另外三条腿逐行相同；那四条"边界"case 钉住报错本身。

/** 词法：`(`、`)`、`"串"`、原子；`;;` 到行尾、`(; … ;)` 成块，都是注释。 */
function tokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '(' && text[i + 1] === ';') {         // 块注释（`.wat` 里是 `(; … ;)`，可嵌套）
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '(' && text[i + 1] === ';') { depth += 1; i += 2; continue; }
        if (text[i] === ';' && text[i + 1] === ')') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '(' || c === ')') { out.push(c); i += 1; continue; }
    if (c === '"') {
      // `.wat` 的串转义：`\n` `\t` `\r` `\\` `\"` `\'` 与**两位十六进制** `\61`
      // （最后那种不是摆设：`tests/wat/cases/01-numeric.wat` 的导出名写成 `m\61in`）
      const ESC = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
      let s = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] !== '\\') { s += text[i]; i += 1; continue; }
        const e = text[i + 1];
        if (ESC[e] !== undefined) { s += ESC[e]; i += 2; continue; }
        if (/[0-9a-fA-F]/.test(e) && /[0-9a-fA-F]/.test(text[i + 2])) {
          s += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
          i += 3;
          continue;
        }
        throw new Error(`wasm: 串里这个转义不认：\\${e}`);
      }
      i += 1;
      out.push({ str: s });
      continue;
    }
    let a = '';
    while (i < text.length && !/[\s()]/.test(text[i])) { a += text[i]; i += 1; }
    out.push(a);
  }
  return out;
}

/** 语法：token 串 -> 嵌套数组（一份 `.wat` 只有一个顶层 form）。 */
function parseWatText(text) {
  const ts = tokens(text);
  let i = 0;
  const form = () => {
    if (ts[i] !== '(') throw new Error(`wasm: 第 ${i} 个记号处该是 '('`);
    i += 1;
    const xs = [];
    while (i < ts.length && ts[i] !== ')') xs.push(ts[i] === '(' ? form() : ts[i++]);
    if (ts[i] !== ')') throw new Error('wasm: 括号没收口');
    i += 1;
    return xs;
  };
  const top = form();
  if (i !== ts.length) throw new Error('wasm: 收口之后还有东西');
  return top;
}

// ---------------------------------------------------------------- 编码的零件

const uleb = (n) => {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return out;
};

const sleb = (n) => {
  const out = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    const signBit = (b & 0x40) !== 0;
    if ((v === 0n && !signBit) || (v === -1n && signBit)) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return out;
};

const f64bytes = (x) => {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x, true);
  return [...new Uint8Array(buf.buffer)];
};

const utf8 = (s) => [...new TextEncoder().encode(s)];
const name = (s) => [...uleb(utf8(s).length), ...utf8(s)];

/**
 * 一格整数字面量 -> BigInt。**十六进制与负号要一起处理**：`BigInt("-0x10")` 会抛，
 * 而 `.wat` 里 `-0x10` 是合法写法（`tests/wat/cases/03-memory.wat` 就有十六进制）。
 * 下划线分隔（`1_000`）也收 —— 规范允许，语料里出现过。
 */
function bigOf(text) {
  const s = String(text).replace(/_/g, '');
  return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
}
const VAL = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
const valtype = (t) => {
  if (VAL[t] === undefined) throw new Error(`wasm: 没见过的值类型 ${t}`);
  return VAL[t];
};
/** 一段带长度前缀（section 与 code 都要）。 */
const sized = (bytes) => [...uleb(bytes.length), ...bytes];

/**
 * **算子表**：只收 `backend-wat.js` 真发过的那些（`grep` 出来的一份清单，不是抄规范）。
 * 值是操作码；`i64.load` 那几格后面还要跟 align/offset，见 `MEM`。
 */
const WASM_OPS = new Map(Object.entries({
  'i64.eqz': 0x50, 'i64.eq': 0x51, 'i64.ne': 0x52, 'i64.lt_s': 0x53, 'i64.gt_s': 0x55,
  'i64.le_s': 0x57, 'i64.ge_s': 0x59,
  'i64.add': 0x7c, 'i64.sub': 0x7d, 'i64.mul': 0x7e, 'i64.div_s': 0x7f, 'i64.rem_s': 0x81,
  /* 位运算那五格（位运算那一刀落地时补的 —— 这张表只收 backend-wat.js 真发过的算子，
     所以它一涨这儿就要跟着涨；`tests/graph/wasm.js` 当场把这一条钉住了）。 */
  'i64.and': 0x83, 'i64.or': 0x84, 'i64.xor': 0x85,
  'i64.shl': 0x86, 'i64.shr_s': 0x87,
  'i32.eqz': 0x45, 'i32.eq': 0x46, 'i32.ne': 0x47, 'i32.lt_s': 0x48, 'i32.lt_u': 0x49,
  'i32.ge_s': 0x4e,
  'i32.add': 0x6a, 'i32.sub': 0x6b, 'i32.mul': 0x6c, 'i32.div_s': 0x6d, 'i32.div_u': 0x6e,
  'i32.rem_s': 0x6f, 'i32.shr_u': 0x76,
  'f64.eq': 0x61, 'f64.ne': 0x62, 'f64.lt': 0x63, 'f64.gt': 0x64, 'f64.le': 0x65, 'f64.ge': 0x66,
  'f64.neg': 0x9a, 'f64.add': 0xa0, 'f64.sub': 0xa1, 'f64.mul': 0xa2, 'f64.div': 0xa3,
  'i32.wrap_i64': 0xa7, 'i64.extend_i32_s': 0xac, 'i64.extend_i32_u': 0xad,
  'i64.trunc_f64_s': 0xb0, 'f64.convert_i64_s': 0xb9,
  drop: 0x1a, return: 0x0f, nop: 0x01, unreachable: 0x00,
}));

/**
 * 访存那几格：操作码 + **自然对齐**（log2 的字节数）。`align=` / `offset=` 写在源文本里时
 * 盖过这两个默认值（`tests/wat/cases/03-memory.wat` 两种都用了）。
 */
const MEM = new Map(Object.entries({
  'i32.load': [0x28, 2], 'i64.load': [0x29, 3], 'f64.load': [0x2b, 3],
  'i32.load8_s': [0x2c, 0], 'i32.load8_u': [0x2d, 0],
  'i32.load16_s': [0x2e, 1], 'i32.load16_u': [0x2f, 1],
  'i64.load32_s': [0x34, 2], 'i64.load32_u': [0x35, 2],
  'i32.store': [0x36, 2], 'i64.store': [0x37, 3], 'f64.store': [0x39, 3],
  'i32.store8': [0x3a, 0], 'i32.store16': [0x3b, 1],
  'i64.store8': [0x3c, 0], 'i64.store16': [0x3d, 1], 'i64.store32': [0x3e, 2],
}));

/**
 * `.wat` 文本 -> 一份 wasm 二进制（`Uint8Array`，能直接喂 `WebAssembly.instantiate`）。
 * 看不懂的东西一律当场抛错 —— 见文件头那句"不许猜着编"。
 */
export function watToWasm(text) {
  const mod = parseWatText(text);
  if (mod[0] !== 'module') throw new Error('wasm: 顶层不是 (module …)');

  const types = [];                       // 签名去重（一份签名一格）
  const typeIdx = (params, results) => {
    const key = `${params.join(',')}->${results.join(',')}`;
    const at = types.findIndex((t) => t.key === key);
    if (at >= 0) return at;
    types.push({ key, params, results });
    return types.length - 1;
  };
  const imports = [];
  const funcs = [];
  const globals = [];
  const datas = [];
  const exps = [];
  const tidByName = new Map();     // `(type $sig …)` 的名字 -> 类型下标
  const elems = [];
  let tableN = null;
  let memMin = null;
  let memMax = null;
  let startId = null;

  // ---- 一遍走完模块层：只认文件头列的那几种 form
  for (const it of mod.slice(1)) {
    if (!Array.isArray(it)) throw new Error(`wasm: 模块层出现了裸记号 ${it}`);
    const h = it[0];
    if (h === 'import') {
      const [, m, nm, f] = it;
      if (!Array.isArray(f) || f[0] !== 'func') throw new Error('wasm: 只认 (import … (func …))');
      const { id, params, results } = signature(f);
      imports.push({ mod: m.str, nm: nm.str, id, typeidx: typeIdx(params.map((p) => p.type), results) });
    } else if (h === 'memory') {
      memMin = Number(it[1]);
      memMax = it[2] === undefined ? null : Number(it[2]);
    } else if (h === 'global') {
      const [, id, t, init] = it;
      const mut = Array.isArray(t);
      globals.push({ id, type: mut ? t[1] : t, mut, init });
    } else if (h === 'data') {
      const [, off, ...bs] = it;
      // 两种写法都有：一串十进制字节，或者一个串字面量（`(data (i32.const 0) "AB")`）
      const bytes = bs.length === 1 && typeof bs[0] === 'object' && bs[0].str !== undefined
        ? utf8(bs[0].str) : bs.map(Number);
      datas.push({ off, bytes });
    } else if (h === 'func') {
      const { id, params, results, locals, body, inlineExports } = signature(it, true);
      funcs.push({ id, params, results, locals, body, typeidx: typeIdx(params.map((p) => p.type), results) });
      for (const nm of inlineExports) exps.push({ name: nm, kind: 0x00, id });
    } else if (h === 'start') {
      startId = it[1];
    } else if (h === 'type') {
      // `(type $sig (func (param i64) (result i64)))` —— 间接调用要一个**有名字的**签名
      const [, id, f] = it;
      if (!Array.isArray(f) || f[0] !== 'func') throw new Error('wasm: (type … ) 里要一个 (func …)');
      const { params, results } = signature(f);
      tidByName.set(id, typeIdx(params.map((p) => p.type), results));
    } else if (h === 'table') {
      // `(table N funcref)` —— 函数值就是这张表上的下标（"函数当值用"那条账的落点）
      if (it[2] !== 'funcref' && it[2] !== 'anyfunc') throw new Error('wasm: 表里只收 funcref');
      tableN = Number(it[1]);
    } else if (h === 'elem') {
      // `(elem (i32.const 0) $a $b …)` —— 往表里填函数
      const [, off, ...ids] = it;
      elems.push({ off, ids });
    } else if (h === 'export') {
      const [, nm, what] = it;
      if (!Array.isArray(what)) throw new Error('wasm: (export …) 后面要一个 (func …) / (memory …)');
      if (what[0] === 'func') exps.push({ name: nm.str, kind: 0x00, id: what[1] });
      else if (what[0] === 'memory') exps.push({ name: nm.str, kind: 0x02, memidx: Number(what[1]) });
      else throw new Error(`wasm: 还不认 (export … (${what[0]} …))`);
    } else throw new Error(`wasm: 模块层还没见过 (${h} …)`);
  }

  // ---- 索引空间：函数是"导入的先、定义的后"（规范就这么定的，弄反了整份都错）
  const fidx = new Map();
  imports.forEach((im, k) => fidx.set(im.id, k));
  funcs.forEach((f, k) => fidx.set(f.id, imports.length + k));
  const gidx = new Map();
  globals.forEach((g, k) => gidx.set(g.id, k));

  // `typeIdx` 也传进去：`call_indirect` 的**内联签名**写法要"用这份签名，没有就添一格"，
  // 而类型段是在下面拼的（比这一行晚），所以这儿添进 `types` 还赶得上
  const bodies = funcs.map((f) => encodeFunc(f, { fidx, gidx, tidByName, typeIdx }));

  // ---- 拼段。**顺序是规范定的**：1 type · 2 import · 3 func · 4 table · 5 memory ·
  //      6 global · 7 export · 8 start · 9 elem · 10 code · 11 data
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const sec = (id, payload) => {
    if (payload === null) return;
    out.push(id, ...sized(payload));
  };
  sec(1, vec(types.map((t) => [0x60, ...vec(t.params.map(valtype)), ...vec(t.results.map(valtype))])));
  sec(2, imports.length === 0 ? null
    : vec(imports.map((im) => [...name(im.mod), ...name(im.nm), 0x00, ...uleb(im.typeidx)])));
  sec(3, funcs.length === 0 ? null : vec(funcs.map((f) => uleb(f.typeidx))));
  // 4 table：函数表（`funcref` 那一种，0x70）
  sec(4, tableN === null ? null : vec([[0x70, 0x00, ...uleb(tableN)]]));
  sec(5, memMin === null ? null
    : vec([memMax === null ? [0x00, ...uleb(memMin)] : [0x01, ...uleb(memMin), ...uleb(memMax)]]));
  sec(6, globals.length === 0 ? null
    : vec(globals.map((g) => [valtype(g.type), g.mut ? 0x01 : 0x00,
      ...encodeExpr(g.init, { fidx, gidx, locals: new Map(), labels: [] }), 0x0b])));
  sec(7, exps.length === 0 ? null
    : vec(exps.map((e) => [...name(e.name), e.kind,
      ...uleb(e.kind === 0x00 ? idxOf(fidx, e.id) : e.memidx)])));
  // 8 start：入口也可以不靠导出名（`tests/wat/cases/02-control.wat` 用的就是这种）
  sec(8, startId === null ? null : uleb(idxOf(fidx, startId)));
  // 9 elem：往表里填函数（`(elem (i32.const 0) $a $b …)`）
  sec(9, elems.length === 0 ? null
    : vec(elems.map((e) => [0x00,
      ...encodeExpr(e.off, { fidx, gidx, tidByName, locals: new Map(), labels: [] }), 0x0b,
      ...vec(e.ids.map((id) => uleb(idxOf(fidx, id))))])));
  sec(10, funcs.length === 0 ? null : vec(bodies));
  sec(11, datas.length === 0 ? null
    : vec(datas.map((d) => [0x00,
      ...encodeExpr(d.off, { fidx, gidx, locals: new Map(), labels: [] }), 0x0b,
      ...uleb(d.bytes.length), ...d.bytes])));
  return new Uint8Array(out);
}

/** 一串带个数前缀（vec(T) 在规范里到处都是）。 */
const vec = (items) => [...uleb(items.length), ...items.flat()];

const idxOf = (m, id) => {
  const v = m.get(id);
  if (v === undefined) throw new Error(`wasm: 没有 ${id} 这个名字`);
  return v;
};

/** 读 `(func $id (param …)… (result T)? (local …)… body…)` 的头几格。 */
function signature(f, wantBody = false) {
  let i = 1;
  const id = typeof f[i] === 'string' && f[i].startsWith('$') ? f[i++] : null;
  const params = [];
  const results = [];
  const locals = [];
  const inlineExports = [];
  for (; i < f.length; i += 1) {
    const it = f[i];
    if (!Array.isArray(it)) break;
    if (it[0] === 'param') {
      // `(param $n i64)` 与 `(param i64)`（导入那侧不给名字）两种都有
      if (String(it[1]).startsWith('$')) params.push({ id: it[1], type: it[2] });
      else for (const t of it.slice(1)) params.push({ id: null, type: t });
    } else if (it[0] === 'result') results.push(...it.slice(1));
    else if (it[0] === 'local') {
      // `(local $x i64)` 与 `(local i64)`（按下标用的匿名局部量）两种都有
      if (String(it[1]).startsWith('$')) locals.push({ id: it[1], type: it[2] });
      else for (const t of it.slice(1)) locals.push({ id: null, type: t });
    } else if (it[0] === 'export') inlineExports.push(it[1].str);   // `(func $f (export "m") …)`
    else break;
  }
  return { id, params, results, locals, body: wantBody ? f.slice(i) : [], inlineExports };
}

/** 一格函数体：局部量表（同类型合并）+ 指令 + `end`，外面再加长度前缀。 */
function encodeFunc(f, ctx) {
  const locals = new Map();
  f.params.forEach((p, k) => { if (p.id !== null) locals.set(p.id, k); });
  f.locals.forEach((l, k) => { if (l.id !== null) locals.set(l.id, f.params.length + k); });
  const groups = [];
  for (const l of f.locals) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.type === l.type) last.n += 1;
    else groups.push({ type: l.type, n: 1 });
  }
  const body = [];
  for (const form of f.body) body.push(...code(form, { ...ctx, locals, labels: [] }));
  return sized([...vec(groups.map((g) => [...uleb(g.n), valtype(g.type)])), ...body, 0x0b]);
}

/** 一格常量表达式（global 的初值、data 的偏移）—— 走同一条 `code`。 */
const encodeExpr = (form, ctx) => code(form, ctx);

/**
 * 一格折叠写法的指令 -> 字节。**子表达式先发，算子后发** —— 折叠写法与栈机的关系就这一句。
 */
function code(form, ctx) {
  if (!Array.isArray(form)) {
    // 裸记号：只可能是没有立即数、也没有操作数的那几格（`return` / `drop` / `nop` …）
    if (WASM_OPS.has(form)) return [WASM_OPS.get(form)];
    throw new Error(`wasm: 裸记号 ${form} 不认（后端没发过这种写法）`);
  }
  const h = form[0];
  const kids = form.slice(1);
  const sub = (xs) => xs.flatMap((x) => code(x, ctx));
  /** 局部量既可以写名字（`$x`）也可以写下标（`local.get 2`）—— 两种都收。 */
  const local = (tok) => (String(tok).startsWith('$') ? idxOf(ctx.locals, tok) : Number(tok));

  if (h === 'block' || h === 'loop') {
    const label = typeof kids[0] === 'string' && kids[0].startsWith('$') ? kids.shift() : null;
    const inner = { ...ctx, labels: [...ctx.labels, label] };
    return [h === 'block' ? 0x02 : 0x03, 0x40, ...kids.flatMap((x) => code(x, inner)), 0x0b];
  }
  if (h === 'if') {
    // 折叠写法：`(if COND (then …) (else …)?)` —— 条件在最前，两支各是一个 form
    const parts = [...kids];
    const thenAt = parts.findIndex((x) => Array.isArray(x) && x[0] === 'then');
    if (thenAt < 0) throw new Error('wasm: (if …) 里没有 (then …)');
    const cond = parts.slice(0, thenAt);
    const thenBody = parts[thenAt].slice(1);
    const elseForm = parts.find((x) => Array.isArray(x) && x[0] === 'else');
    const inner = { ...ctx, labels: [...ctx.labels, null] };   // if 也占一层标签
    const out = [...sub(cond), 0x04, 0x40, ...thenBody.flatMap((x) => code(x, inner))];
    if (elseForm !== undefined) out.push(0x05, ...elseForm.slice(1).flatMap((x) => code(x, inner)));
    out.push(0x0b);
    return out;
  }
  if (h === 'br' || h === 'br_if') {
    // 标签既可以写名字（`br $L`）也可以写深度（`br 1`）
    const depth = String(kids[0]).startsWith('$')
      ? (() => {
        const at = ctx.labels.lastIndexOf(kids[0]);
        if (at < 0) throw new Error(`wasm: ${h} ${kids[0]} —— 这个标签不在作用域里`);
        return ctx.labels.length - 1 - at;
      })() : Number(kids[0]);
    return h === 'br' ? [0x0c, ...uleb(depth)] : [...sub(kids.slice(1)), 0x0d, ...uleb(depth)];
  }
  if (h === 'call') return [...sub(kids.slice(1)), 0x10, ...uleb(idxOf(ctx.fidx, kids[0]))];
  if (h === 'call_indirect') {
    // `(call_indirect (type $sig) 实参… 下标)` —— 下标最后进栈（它是 `call_indirect` 的操作数）。
    // **内联签名**也收（`(call_indirect (param i64) 实参… 下标)`）：那是 WAT 的缩写，
    // 意思就是"用这份签名，模块里没有就添一格"—— 所以照着 typeIdx 去重那条路走。
    const isSig = (x) => Array.isArray(x) && (x[0] === 'param' || x[0] === 'result');
    let tid;
    let k = 0;
    if (Array.isArray(kids[0]) && kids[0][0] === 'type') {
      tid = ctx.tidByName?.get(kids[0][1]);
      if (tid === undefined) throw new Error(`wasm: 没有 ${kids[0][1]} 这个签名（模块层要有 (type …)）`);
      k = 1;
      while (isSig(kids[k])) k += 1;    // `(type $s)` 后面把签名再写一遍是允许的，跳过
    } else if (isSig(kids[0])) {
      const parts = [];
      while (isSig(kids[k])) parts.push(kids[k++]);
      const { params, results } = signature(['func', ...parts]);
      tid = ctx.typeIdx(params.map((p) => p.type), results);
    } else {
      throw new Error('wasm: call_indirect 要 (type $sig) 或者内联签名 (param …) (result …)');
    }
    return [...sub(kids.slice(k)), 0x11, ...uleb(tid), 0x00];
  }
  if (h === 'local.get') return [0x20, ...uleb(local(kids[0]))];
  if (h === 'local.set' || h === 'local.tee') {
    return [...sub(kids.slice(1)), h === 'local.set' ? 0x21 : 0x22, ...uleb(local(kids[0]))];
  }
  if (h === 'global.get') return [0x23, ...uleb(idxOf(ctx.gidx, kids[0]))];
  if (h === 'global.set') return [...sub(kids.slice(1)), 0x24, ...uleb(idxOf(ctx.gidx, kids[0]))];
  if (h === 'i32.const') return [0x41, ...sleb(BigInt.asIntN(32, bigOf(kids[0])))];
  if (h === 'i64.const') return [0x42, ...sleb(BigInt.asIntN(64, bigOf(kids[0])))];
  if (h === 'f64.const') return [0x44, ...f64bytes(Number(kids[0]))];
  if (MEM.has(h)) {
    const [op, natural] = MEM.get(h);
    // `align=N` / `offset=N` 写在算子后面（**在操作数之前**），给了就盖过默认值
    let align = natural;
    let offset = 0;
    const rest = [...kids];
    while (typeof rest[0] === 'string' && /^(align|offset)=/.test(rest[0])) {
      const [k, v] = rest.shift().split('=');
      if (k === 'offset') offset = Number(v);
      else align = Math.log2(Number(v));           // 源文本写的是字节数，编码要 log2
    }
    if (!Number.isInteger(align)) throw new Error(`wasm: align= 只能是 2 的幂（${h}）`);
    return [...sub(rest), op, ...uleb(align), ...uleb(offset)];
  }
  if (h === 'memory.size') return [0x3f, 0x00];
  if (h === 'memory.grow') return [...sub(kids), 0x40, 0x00];
  if (WASM_OPS.has(h)) return [...sub(kids), WASM_OPS.get(h)];
  throw new Error(`wasm: 还没见过的算子 ${h}（这一份只收 backend-wat.js 真发过的那些）`);
}




