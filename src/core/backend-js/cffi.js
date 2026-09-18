/**
 * `(ccall …)` 在 node 这条腿上的桥（ADR-0038）。
 *
 * 这一份是**纯函数**：`mod.cabi` / `mod.cabiSig` / `mod.libs` 三格进去，两段文本出来 ——
 * 一份 `.c`（每个用到的 C 符号一个 N-API 包装函数）与一段 JS（装载 + 地址换算）。
 * 不看调用点：签名从声明来（与 LLVM 那条腿的 `cabiArg`、C 那条腿的 `cAbiExterns`
 * 读的是同一格），所以三条腿对同一个 C ABI 不可能分叉。
 *
 * 地址这件事全在 JS 那一侧算（见 `cffiGlue` 的 `$fp`/`$ft`/`$fs`/`$fa`）：C 这一侧
 * 每个 `ptr` 形参收到的都是一格**机器地址**，于是包装函数里没有一处要猜"这个数是
 * 偏移还是地址"。
 */

import { C_TYPE } from '../hir/c_abi.js';

/** 变参最多收几格（`2^1+…+2^6 = 126` 条分派，见 ADR-0038 变参那一节）。 */
export const CFFI_VA_MAX = 6;

/**
 * 这个模块里要发包装函数的那几条：**声明在源码里**的那些（`mod.cabiSig[i]` 有值）。
 *
 * 封闭表（`hir/c_abi.js` 的 8 条 libc）那一族不在里头 —— 它们的实参是 dynamic 装箱值，
 * 语义是 `C_IN`/`C_OUT` 那对 marshaler，与这条路的"机器值直通"不是同一件事（ADR-0038
 * 「留在门外的东西」第一条）。
 */
export function cffiEntries(mod) {
  const names = mod.cabi ?? [];
  const sigs = mod.cabiSig ?? [];
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const s = sigs[i];
    if (s === undefined || s === null) continue;
    out.push({
      sym: names[i],
      params: s.params.slice(),
      ret: s.ret,
      variadic: s.variadic === true,
    });
  }
  return out;
}

/** 这个模块要不要那份扩展。 */
export function cffiNeeded(mod) {
  return cffiEntries(mod).length > 0;
}

/* ---------------------------------------------------------------- C 那一侧 */

/** 一格形参：从 `argv[ai]` 取出来，落在局部 `p<k>` 上。 */
function cffiGet(w, k, ai, sym) {
  const v = `p${k}`;
  const bad = `if (st != omni_napi_ok) return omni_ffi_bad(env, "${sym}", ${k});`;
  if (w === 'f64' || w === 'f32') {
    return [`  double d${k} = 0;`, `  st = napi_get_value_double(env, a[${ai}], &d${k});`,
      `  ${bad}`, `  ${C_TYPE[w]} ${v} = (${C_TYPE[w]})d${k};`];
  }
  if (w === 'i32') {
    return [`  int32_t ${v} = 0;`, `  st = napi_get_value_int32(env, a[${ai}], &${v});`, `  ${bad}`];
  }
  if (w === 'bool') {
    return [`  bool ${v} = false;`, `  st = napi_get_value_bool(env, a[${ai}], &${v});`, `  ${bad}`];
  }
  /* i64 与 ptr 都从 BigInt 来（地址装不进 double 的那一格不该靠"通常够用"活着）。 */
  const lines = [`  int64_t w${k} = 0;`, `  st = napi_get_value_bigint_int64(env, a[${ai}], &w${k}, &lossless);`,
    `  ${bad}`];
  if (w === 'ptr') lines.push(`  void *${v} = (void *)(intptr_t)w${k};`);
  else lines.push(`  int64_t ${v} = w${k};`);
  return lines;
}

/** 回值：把 C 的结果变成一格 `napi_value`（`void` 的那一支不带结果变量）。 */
function cffiRet(ret, call) {
  const out = [];
  if (ret === 'void') {
    out.push(`  ${call};`);
    out.push('  napi_value r; napi_get_undefined(env, &r); return r;');
    return out;
  }
  out.push(`  ${C_TYPE[ret]} rv = ${call};`);
  out.push('  napi_value r;');
  if (ret === 'i32') out.push('  napi_create_int32(env, rv, &r);');
  else if (ret === 'f64' || ret === 'f32') out.push('  napi_create_double(env, (double)rv, &r);');
  else if (ret === 'bool') out.push('  napi_get_boolean(env, rv, &r);');
  else if (ret === 'ptr') out.push('  napi_create_bigint_int64(env, (int64_t)(intptr_t)rv, &r);');
  else out.push('  napi_create_bigint_int64(env, rv, &r);');
  out.push('  return r;');
  return out;
}

/** 变参那一族的分派：`kn * 64 + bits` 一格一条，`i` 是 int64_t、`d` 是 double。 */
function cffiVaSwitch(e, fixed, retVoid) {
  const lines = ['  switch ((int)(kn * 64 + bits)) {'];
  for (let n = 0; n <= CFFI_VA_MAX; n++) {
    for (let bits = 0; bits < (1 << n); bits++) {
      const extras = [];
      for (let k = 0; k < n; k++) extras.push((bits >> k) & 1 ? `vd[${k}]` : `vi[${k}]`);
      const all = fixed.concat(extras).join(', ');
      const call = `${e.sym}(${all})`;
      lines.push(`    case ${n * 64 + bits}: ${retVoid ? call : `rv = ${call}`}; break;`);
    }
  }
  lines.push(`    default: return omni_ffi_bad(env, "${e.sym}", -1);`);
  lines.push('  }');
  return lines;
}

/** 一条声明的 extern 原型（不 include 任何系统头：那会把别人整套声明拖进来）。 */
function cffiProto(e) {
  const ps = e.params.length > 0 ? e.params.map((p) => C_TYPE[p]).join(', ') : 'void';
  const all = e.variadic ? `${ps}, ...` : ps;
  return `extern ${C_TYPE[e.ret]} ${e.sym}(${all});`;
}

/** 一个符号的包装函数。 */
function cffiWrap(e) {
  const nfix = e.params.length;
  /* 变参那一族：`argv[0]` 是 kinds 串，定参从 1 开始（见 ADR-0038 变参那一节）。 */
  const base = e.variadic ? 1 : 0;
  const need = base + nfix;
  const out = [`static napi_value ${e.sym}_w(napi_env env, napi_callback_info info) {`,
    `  size_t argc = ${need + (e.variadic ? CFFI_VA_MAX : 0)};`,
    `  napi_value a[${Math.max(1, need + (e.variadic ? CFFI_VA_MAX : 0))}];`,
    '  napi_status st = napi_get_cb_info(env, info, &argc, a, NULL, NULL);',
    `  bool lossless = false; (void)lossless;`,
    `  if (st != omni_napi_ok || argc < ${need}) return omni_ffi_argc(env, "${e.sym}", ${need});`];
  let kn = null;
  if (e.variadic) {
    out.push('  char kinds[8]; size_t kn = 0;');
    out.push('  st = napi_get_value_string_utf8(env, a[0], kinds, sizeof kinds, &kn);');
    out.push(`  if (st != omni_napi_ok || kn > ${CFFI_VA_MAX}) return omni_ffi_bad(env, "${e.sym}", 0);`);
    out.push(`  if (argc < ${need} + kn) return omni_ffi_argc(env, "${e.sym}", (int)(${need} + kn));`);
    kn = 'kn';
  }
  for (let k = 0; k < nfix; k++) out.push(...cffiGet(e.params[k], k, base + k, e.sym));
  const fixed = [];
  for (let k = 0; k < nfix; k++) fixed.push(`p${k}`);
  if (!e.variadic) {
    out.push(...cffiRet(e.ret, `${e.sym}(${fixed.join(', ')})`));
    out.push('}');
    return out;
  }
  /* 变参那几格：整数类一律 int64_t、浮点一律 double —— C 的默认实参提升，与 C 那条腿
     `case 'CCall'` 里 `raw` 那一支写的规则逐字相同。 */
  out.push('  int64_t vi[8]; double vd[8]; int bits = 0;');
  out.push('  for (size_t k = 0; k < kn; k++) {');
  out.push('    vi[k] = 0; vd[k] = 0;');
  out.push(`    if (kinds[k] == 'd') { st = napi_get_value_double(env, a[${need} + k], &vd[k]); bits |= 1 << k; }`);
  out.push(`    else st = napi_get_value_bigint_int64(env, a[${need} + k], &vi[k], &lossless);`);
  out.push(`    if (st != omni_napi_ok) return omni_ffi_bad(env, "${e.sym}", (int)(${nfix} + k));`);
  out.push('  }');
  const retVoid = e.ret === 'void';
  if (!retVoid) out.push(`  ${C_TYPE[e.ret]} rv = 0;`);
  out.push(...cffiVaSwitch(e, fixed, retVoid));
  if (retVoid) {
    out.push('  napi_value r; napi_get_undefined(env, &r); return r;');
  } else {
    out.push('  napi_value r;');
    if (e.ret === 'i32') out.push('  napi_create_int32(env, rv, &r);');
    else if (e.ret === 'f64' || e.ret === 'f32') out.push('  napi_create_double(env, (double)rv, &r);');
    else if (e.ret === 'bool') out.push('  napi_get_boolean(env, rv, &r);');
    else if (e.ret === 'ptr') out.push('  napi_create_bigint_int64(env, (int64_t)(intptr_t)rv, &r);');
    else out.push('  napi_create_bigint_int64(env, rv, &r);');
    out.push('  return r;');
  }
  out.push('}');
  void kn;
  return out;
}

/** 那份 `.c` 的全文。 */
export function cffiSource(mod) {
  const es = cffiEntries(mod);
  const out = [`/* 这份文件是**发出来的**（src/core/backend-js/cffi.js，ADR-0038）—— 不要手改。
 *
 * 一个 \`(cabi …)\` 一个包装函数：实参从 N-API 那一侧取成机器值、调那个真符号、
 * 回值再变回一格 napi_value。\`ptr\` 收到的一律是**机器地址**（偏移加基址那一步在
 * 发出来的 JS 里做，见 cffiGlue）。
 */`,
  '#include "omni_napi.h"', '',
  `/* 拼消息全自己来：**一个系统头都不 include**。理由是硬的 —— \`(cabi printf …)\` 那一族
   要发 \`extern int32_t printf(void *, ...);\`，而 \`<stdio.h>\` 里那条是
   \`int printf(const char *, ...)\`：两条摆在同一个 TU 里 clang 报的是 conflicting types
   （**error**，不是 warning，量过）。没有那个头的时候只是一句
   incompatible-library-redeclaration 的提醒。 */
static void omni_ffi_puts(char *dst, size_t cap, size_t *n, const char *s) {
  while (*s != 0 && *n + 1 < cap) dst[(*n)++] = *s++;
  dst[*n] = 0;
}

static void omni_ffi_putn(char *dst, size_t cap, size_t *n, int v) {
  char tmp[16];
  int m = 0;
  if (v < 0) { omni_ffi_puts(dst, cap, n, "-"); v = -v; }
  do { tmp[m++] = (char)('0' + v % 10); v /= 10; } while (v != 0);
  while (m > 0 && *n + 1 < cap) dst[(*n)++] = tmp[--m];
  dst[*n] = 0;
}

/* 一次取不出来的实参报的是"第几个"：那句话比 "invalid argument" 有用。
   \`i >= 0\` 第几格取不出来 · \`-1\` 变参那一段的形状不认得 · \`-2\` 实参个数不对。 */
static napi_value omni_ffi_bad(napi_env env, const char *sym, int i) {
  char msg[256];
  size_t n = 0;
  omni_ffi_puts(msg, sizeof msg, &n, "omni ffi: ");
  omni_ffi_puts(msg, sizeof msg, &n, sym);
  if (i == -2) {
    omni_ffi_puts(msg, sizeof msg, &n, ": 实参个数不对");
  } else if (i == -1) {
    omni_ffi_puts(msg, sizeof msg, &n, ": 变参那一段的形状不认得");
  } else {
    omni_ffi_puts(msg, sizeof msg, &n, ": 第 ");
    omni_ffi_putn(msg, sizeof msg, &n, i + 1);
    omni_ffi_puts(msg, sizeof msg, &n, " 个实参取不出来");
  }
  napi_throw_error(env, NULL, msg);
  return NULL;
}

static napi_value omni_ffi_argc(napi_env env, const char *sym, int want) {
  (void)want;
  return omni_ffi_bad(env, sym, -2);
}

/* 一块 ArrayBuffer 的**真地址**（ADR-0038 第二条约定）。发出来的 JS 拿它做偏移加基址。 */
static napi_value omni_ffi_base(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value a[1];
  void *p = NULL;
  size_t len = 0;
  napi_value r;
  if (napi_get_cb_info(env, info, &argc, a, NULL, NULL) != omni_napi_ok || argc < 1) {
    return omni_ffi_bad(env, "$base", 0);
  }
  if (napi_get_arraybuffer_info(env, a[0], &p, &len) != omni_napi_ok) {
    return omni_ffi_bad(env, "$base", 0);
  }
  napi_create_bigint_int64(env, (int64_t)(intptr_t)p, &r);
  return r;
}`, ''];
  out.push('/* ---- 那几个真符号的原型 ---- */');
  for (const e of es) out.push(cffiProto(e));
  out.push('');
  out.push('/* ---- 包装 ---- */');
  for (const e of es) { out.push(...cffiWrap(e)); out.push(''); }
  out.push('napi_value napi_register_module_v1(napi_env env, napi_value exports) {');
  out.push('  napi_value f;');
  out.push('  napi_create_function(env, "$base", (size_t)-1, omni_ffi_base, NULL, &f);');
  out.push('  napi_set_named_property(env, exports, "$base", f);');
  for (const e of es) {
    out.push(`  napi_create_function(env, "${e.sym}", (size_t)-1, ${e.sym}_w, NULL, &f);`);
    out.push(`  napi_set_named_property(env, exports, "${e.sym}", f);`);
  }
  out.push('  return exports;');
  out.push('}');
  return `${out.join('\n')}\n`;
}

/* --------------------------------------------------------------- JS 那一侧 */

/**
 * 发出来那份 JS 里的 FFI 前段：拿到那格 `$cffi` + 四个地址换算。
 *
 * 两条路都从这儿进（ADR-0038 第二刀）：
 *   - **注入**（默认）：编译器在**本进程里**已经把那份 C 造成机器码注好了，
 *     结果摆在宿主全局的 `$OMNI_CFFI` 上（`host/ffi_host.js` 的 `publishCffi`）。
 *   - **编到文件**（备选，`OMNI_FFI=cc`）：一份 `.node`，路径走 `OMNI_FFI_ADDON`。
 *     **不写进正文** —— 那样同一个程序发出来的字节与这台机器上的缓存路径无关。
 *
 * 次序是"先看全局、再看环境变量"：`omni build --backend js` 出来的独立产物里没有那格
 * 全局（编译器不在场），于是它自动落到第二条路上 —— 那一格也是这条路存在的理由之一。
 */
export function cffiGlue() {
  return `
/* ---- FFI（ADR-0038）：那格 $cffi + 地址换算 ---- */
const $cffi = (() => {
  /* 注进来的那一格（编译器在本进程里，ADR-0038 第二刀）。 */
  if (typeof globalThis !== "undefined" && globalThis.$OMNI_CFFI !== undefined) {
    return globalThis.$OMNI_CFFI;
  }
  /* 备选：一份编好的 .node（外部 cc 那条路，更通用）。 */
  const p = typeof process === "undefined" ? undefined : process.env.OMNI_FFI_ADDON;
  if (p === undefined || p === "") {
    $rt_error("omni ffi: 既没有注进来的那一格、也没有 OMNI_FFI_ADDON —— "
      + "这份 JS 里有 (ccall …)，要那份 N-API 扩展才跑得起来（ADR-0038）");
  }
  const m = { exports: {} };
  process.dlopen(m, p);
  return m.exports;
})();
/* arena 的基址：$mgrow 会换一块 ArrayBuffer，所以每次用之前对一眼是不是同一块。 */
let $ffiBuf = null;
let $ffiAddr = 0n;
function $ffiBase() {
  if ($ffiBuf !== $mem) { $ffiAddr = $cffi.$base($mem); $ffiBuf = $mem; }
  return $ffiAddr;
}
/* 胖指针 / 瘦指针 / 已经是地址的 int */
const $fp = (p) => $ffiBase() + BigInt(p[0]);
const $ft = (a) => $ffiBase() + BigInt(a);
const $fa = (v) => BigInt(v);
/* 串：写进 FFI 自己那块**不会被换掉**的草稿区（环形，64KB），带结尾的零。
   与原生腿"字面量池里那条带零的字节"同一个约定；地址只在这次调用期间有效。 */
const $ffiScr = new ArrayBuffer(1 << 16);
const $ffiScrU8 = new Uint8Array($ffiScr);
const $ffiEnc = new TextEncoder();
let $ffiScrBase = null;
let $ffiScrTop = 0;
function $fs(s) {
  if ($ffiScrBase === null) $ffiScrBase = $cffi.$base($ffiScr);
  const b = $ffiEnc.encode(s);
  if (b.length + 1 > $ffiScrU8.length) {
    $rt_error("omni ffi: 交给 C 的串有 " + b.length + " 字节，草稿区只有 " + $ffiScrU8.length);
  }
  if ($ffiScrTop + b.length + 1 > $ffiScrU8.length) $ffiScrTop = 0;
  const a = $ffiScrTop;
  $ffiScrU8.set(b, a);
  $ffiScrU8[a + b.length] = 0;
  $ffiScrTop = a + b.length + 1;
  return $ffiScrBase + BigInt(a);
}
`;
}
