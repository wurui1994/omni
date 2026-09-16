// src/core/wasm/assemble.js —— **WAT 文本 -> wasm 二进制**（就为了能交给一个真引擎跑）
//
// 这一份的来由是一笔记了很久的账：图那条 wat 腿的正确性一直由 `frontend-wat` + MIR 解释器
// 证 —— 那是一条**互不相干的实现**，可它仍然在这棵树里。"wasm 必须是后端"这句话要立得住，
// 那份 `.wat` 得让**外面的引擎**认。写这段的机器上没有 wabt / wasmtime，
// 但 Node 自带 V8，而 V8 里那台 wasm 引擎与这棵树没有半点关系 ——
// 缺的只是"文本 -> 二进制"这一步，于是补这一份。
//
// ## 只认我们自己发出去的那个子集（明说，不假装是个通用汇编器）
//
//   模块层：`(module)` `(import "omni" "…" (func $id (param T)…(result T)?))` `(memory N)`
//           `(global $id (mut T) (expr))` `(data (i32.const N) b0 b1 …)`
//           `(func $id (param $p T)… (result T)? (local $l T)… body…)` `(export "n" (func $id))`
//   指令层：折叠写法（`(i64.add (local.get $a) (i64.const 1))`）· `block` / `loop` / `if`+`then`/`else`
//           · `br $L` · `return` · `call` · `drop` · 下面 `OPS` 那张表里的算子
//
// 没有 `table` / `elem` / `call_indirect`（那是"函数当值用"那条账，`backend-wat.js` 里现在
// 报缺口）· 没有 `br_if` / `select` / 位运算 —— 后端一条都没发过。**发到没见过的东西就当场报错**，
// 不许猜着编：编出一份 V8 拒收的二进制，错会指到最没关系的地方。
//
// 判据在 `tests/graph/wasm.js`：那 76 份例子的 `.wat` 逐个装出二进制、交给
// `WebAssembly.instantiate` 跑，输出与另外三条腿逐行相同。

/** 词法：`(`、`)`、`"串"`、原子；`;;` 到行尾是注释。 */
function tokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '(' || c === ')') { out.push(c); i += 1; continue; }
    if (c === '"') {
      let s = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') { s += text[i + 1]; i += 2; continue; }
        s += text[i];
        i += 1;
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
function parse(text) {
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
const OPS = new Map(Object.entries({
  'i64.eqz': 0x50, 'i64.eq': 0x51, 'i64.ne': 0x52, 'i64.lt_s': 0x53, 'i64.gt_s': 0x55,
  'i64.le_s': 0x57, 'i64.ge_s': 0x59,
  'i64.add': 0x7c, 'i64.sub': 0x7d, 'i64.mul': 0x7e, 'i64.div_s': 0x7f, 'i64.rem_s': 0x81,
  'i32.eqz': 0x45, 'i32.eq': 0x46, 'i32.ne': 0x47, 'i32.lt_s': 0x48, 'i32.ge_s': 0x4e,
  'i32.add': 0x6a, 'i32.sub': 0x6b, 'i32.mul': 0x6c, 'i32.div_s': 0x6d,
  'f64.eq': 0x61, 'f64.ne': 0x62, 'f64.lt': 0x63, 'f64.gt': 0x64, 'f64.le': 0x65, 'f64.ge': 0x66,
  'f64.neg': 0x9a, 'f64.add': 0xa0, 'f64.sub': 0xa1, 'f64.mul': 0xa2, 'f64.div': 0xa3,
  'i32.wrap_i64': 0xa7, 'i64.extend_i32_s': 0xac, 'i64.extend_i32_u': 0xad,
  'i64.trunc_f64_s': 0xb0, 'f64.convert_i64_s': 0xb9,
  drop: 0x1a, return: 0x0f, nop: 0x01, unreachable: 0x00,
}));

/** 访存那几格：操作码 + 对齐（log2 的字节数 —— 自然对齐）。offset 后端从来没发过，恒 0。 */
const MEM = new Map(Object.entries({
  'i64.load': [0x29, 3], 'i64.store': [0x37, 3],
  'i32.load': [0x28, 2], 'i32.store': [0x36, 2],
  'i32.load8_u': [0x2d, 0], 'i32.store8': [0x3a, 0],
}));

/**
 * `.wat` 文本 -> 一份 wasm 二进制（`Uint8Array`，能直接喂 `WebAssembly.instantiate`）。
 * 看不懂的东西一律当场抛错 —— 见文件头那句"不许猜着编"。
 */
export function watToWasm(text) {
  const mod = parse(text);
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
  let memMin = null;

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
    } else if (h === 'global') {
      const [, id, t, init] = it;
      const mut = Array.isArray(t);
      globals.push({ id, type: mut ? t[1] : t, mut, init });
    } else if (h === 'data') {
      const [, off, ...bs] = it;
      datas.push({ off, bytes: bs.map(Number) });
    } else if (h === 'func') {
      const { id, params, results, locals, body } = signature(it, true);
      funcs.push({ id, params, results, locals, body, typeidx: typeIdx(params.map((p) => p.type), results) });
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

  const bodies = funcs.map((f) => encodeFunc(f, { fidx, gidx }));

  // ---- 拼段。**顺序是规范定的**：1 type · 2 import · 3 func · 5 memory · 6 global ·
  //      7 export · 10 code · 11 data（没有 table / elem / start —— 后端不发那些）
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const sec = (id, payload) => {
    if (payload === null) return;
    out.push(id, ...sized(payload));
  };
  sec(1, vec(types.map((t) => [0x60, ...vec(t.params.map(valtype)), ...vec(t.results.map(valtype))])));
  sec(2, imports.length === 0 ? null
    : vec(imports.map((im) => [...name(im.mod), ...name(im.nm), 0x00, ...uleb(im.typeidx)])));
  sec(3, funcs.length === 0 ? null : vec(funcs.map((f) => uleb(f.typeidx))));
  sec(5, memMin === null ? null : vec([[0x00, ...uleb(memMin)]]));
  sec(6, globals.length === 0 ? null
    : vec(globals.map((g) => [valtype(g.type), g.mut ? 0x01 : 0x00,
      ...encodeExpr(g.init, { fidx, gidx, locals: new Map(), labels: [] }), 0x0b])));
  sec(7, exps.length === 0 ? null
    : vec(exps.map((e) => [...name(e.name), e.kind,
      ...uleb(e.kind === 0x00 ? idxOf(fidx, e.id) : e.memidx)])));
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
  for (; i < f.length; i += 1) {
    const it = f[i];
    if (!Array.isArray(it)) break;
    if (it[0] === 'param') {
      // `(param $n i64)` 与 `(param i64)`（导入那侧不给名字）两种都有
      if (String(it[1]).startsWith('$')) params.push({ id: it[1], type: it[2] });
      else for (const t of it.slice(1)) params.push({ id: null, type: t });
    } else if (it[0] === 'result') results.push(...it.slice(1));
    else if (it[0] === 'local') locals.push({ id: it[1], type: it[2] });
    else break;
  }
  return { id, params, results, locals, body: wantBody ? f.slice(i) : [] };
}

/** 一格函数体：局部量表（同类型合并）+ 指令 + `end`，外面再加长度前缀。 */
function encodeFunc(f, ctx) {
  const locals = new Map();
  f.params.forEach((p, k) => { if (p.id !== null) locals.set(p.id, k); });
  f.locals.forEach((l, k) => locals.set(l.id, f.params.length + k));
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
    if (OPS.has(form)) return [OPS.get(form)];
    throw new Error(`wasm: 裸记号 ${form} 不认（后端没发过这种写法）`);
  }
  const h = form[0];
  const kids = form.slice(1);
  const sub = (xs) => xs.flatMap((x) => code(x, ctx));

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
    const at = ctx.labels.lastIndexOf(kids[0]);
    if (at < 0) throw new Error(`wasm: ${h} ${kids[0]} —— 这个标签不在作用域里`);
    const depth = ctx.labels.length - 1 - at;
    return h === 'br' ? [0x0c, ...uleb(depth)] : [...sub(kids.slice(1)), 0x0d, ...uleb(depth)];
  }
  if (h === 'call') return [...sub(kids.slice(1)), 0x10, ...uleb(idxOf(ctx.fidx, kids[0]))];
  if (h === 'local.get') return [0x20, ...uleb(idxOf(ctx.locals, kids[0]))];
  if (h === 'local.set' || h === 'local.tee') {
    return [...sub(kids.slice(1)), h === 'local.set' ? 0x21 : 0x22, ...uleb(idxOf(ctx.locals, kids[0]))];
  }
  if (h === 'global.get') return [0x23, ...uleb(idxOf(ctx.gidx, kids[0]))];
  if (h === 'global.set') return [...sub(kids.slice(1)), 0x24, ...uleb(idxOf(ctx.gidx, kids[0]))];
  if (h === 'i32.const') return [0x41, ...sleb(BigInt(kids[0]))];
  if (h === 'i64.const') return [0x42, ...sleb(BigInt(kids[0]))];
  if (h === 'f64.const') return [0x44, ...f64bytes(Number(kids[0]))];
  if (MEM.has(h)) {
    const [op, align] = MEM.get(h);
    return [...sub(kids), op, ...uleb(align), ...uleb(0)];
  }
  if (OPS.has(h)) return [...sub(kids), OPS.get(h)];
  throw new Error(`wasm: 还没见过的算子 ${h}（这一份只收 backend-wat.js 真发过的那些）`);
}




