// ext/python/adapter/ucase.js —— 大小写那张表怎么进产物（数据段 + 五格内建）
//
// 表在 `ext/python/rt/ucase.tab`（`gen-ucase.js` 从本机 python3 生成的），逻辑在
// `ext/python/lib/ucase.py`。这一份是两者中间那一格：把 `.tab` 读进来摆成一段
// **静态数据**（标准 IR 的 `{kind:'memory'}` + `{kind:'data'}`，`src/core/lower/lower.js`
// 发成方言的 `(memory …)` / `(data …)`），再把 lib 那一份里的五格内建落成 `(mload …)`。
//
// 为什么偏移量不写在 `lib/ucase.py` 里：那几个数是**表的布局**，跟着 `.tab` 的元信息走 ——
// 写进 python 源码就成了两处各记一份，表一重排就静静错。所以 lib 那一侧只说
// "查一级索引第 i 格"，地址是这一份折出来的。
//
// **没人用就一个字节都不进产物**：`ucaseDecls` 只在 `C.ucaseUsed` 为真时交那两条声明
// （用到 `.upper()` 那一族的非 ASCII 才会真）。

import { readText } from '../../../src/core/host/native.js';
import { join } from '../../../src/core/host/path.js';

/** 表摆在第 1 页起（第 0 页按 `tests/sexpr/cases/36-memory.sx` 那条约定不用）。 */
const BASE = 65536;
const PAGE = 65536;

/** 一格记录 56 字节：flags(u16) + 4 个映射各 (count u8 + 3 × 32 位)。 */
const REC_SIZE = 56;
const MAP_SIZE = 13;
const BLOCK = 64;

let cached = null;

/**
 * 把 `ucase.tab` 读进来（元信息 + 字节）。一趟编译只读一次。
 *
 * 十六进制而不是 base64：解码是五行循环，`check:self` 那一档的 JS 子集里什么都不用借。
 */
export function ucaseTable(root) {
  if (cached !== null) return cached;
  const text = readText(join(root ?? '.', 'ext', 'python', 'rt', 'ucase.tab'));
  const meta = new Map();
  let at = 0;
  for (const line of text.split('\n')) {
    at += line.length + 1;
    if (line === 'hex') break;
    if (line === '' || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    meta.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const hex = text.slice(at).split('\n').join('');
  const size = Number(meta.get('size'));
  if (hex.length !== size * 2) {
    throw new Error(`python->IR: ucase.tab 的字节数对不上（元信息说 ${size}，`
      + `十六进制那串是 ${hex.length / 2}）—— 重跑 node ext/python/rt/gen-ucase.js`);
  }
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  cached = {
    bytes,
    size,
    off1: Number(meta.get('off_idx1')),
    off2: Number(meta.get('off_idx2')),
    offRec: Number(meta.get('off_rec')),
    unicode: meta.get('unicode'),
  };
  return cached;
}

/** 那两条模块声明（线性内存 + 初始字节）。没用到就一格都不发。 */
export function ucaseDecls(C) {
  if (C.ucaseUsed !== true) return [];
  const t = ucaseTable(C.root);
  const pages = 1 + Math.ceil(t.size / PAGE);
  return [
    { kind: 'memory', min: pages, max: pages },
    { kind: 'data', off: BASE, bytes: t.bytes },
  ];
}

const int = (value) => ({ kind: 'int', value });
const add = (a, b) => ({ kind: 'binop', op: '+', left: a, right: b });
const mul = (a, b) => ({ kind: 'binop', op: '*', left: a, right: b });
const load = (kind, addr) => ({
  kind: 'builtin', name: 'mload', args: [{ kind: 'mem-kind', name: kind }, addr],
});

/**
 * lib 那一份里的五格内建 —— 交一棵 `(mload …)`，认不得就交 null（交给下游照旧报）。
 *
 * `_urecv` 用 **i32s**：单格映射存的是差值，可以是负的（`A` -> `a` 是 +32、`a` -> `A` 是 -32）。
 * 别的几格都是无符号。
 */
export function ucaseIntrinsic(name, args, C) {
  const five = ['_uidx1', '_uidx2', '_urecf', '_urecn', '_urecv'];
  if (!five.includes(name)) return null;
  const t = ucaseTable(C.root);
  C.ucaseUsed = true;
  const want = name === '_urecv' ? 3 : (name === '_urecn' ? 2 : 1);
  if (args.length !== want) {
    throw new Error(`python->IR: \`${name}()\` 要 ${want} 格实参，给了 ${args.length}`);
  }
  if (name === '_uidx1') return load('i16u', add(int(BASE + t.off1), mul(args[0], int(2))));
  if (name === '_uidx2') return load('i16u', add(int(BASE + t.off2), mul(args[0], int(2))));
  /* 记录那一格的地址：BASE + off_rec + r * 56。 */
  const rec = add(int(BASE + t.offRec), mul(args[0], int(REC_SIZE)));
  if (name === '_urecf') return load('i16u', rec);
  /* 第 w 格映射：+ 2（跳过 flags）+ w * 13。 */
  const map = add(add(rec, int(2)), mul(args[1], int(MAP_SIZE)));
  if (name === '_urecn') return load('i8u', map);
  return load('i32s', add(add(map, int(1)), mul(args[2], int(4))));
}

/** 这五格内建交出来的都是 int（`ty` 那一侧要它）。 */
export const UCASE_INTRIN = new Set(['_uidx1', '_uidx2', '_urecf', '_urecn', '_urecv']);

export { BASE as UCASE_BASE, BLOCK as UCASE_BLOCK };
