/* `ar` 静态库的读取 —— ADR-0017 第 11 步，第九刀第四十六片。
 *
 * 链接可执行文件必须先能读库：`libtcc1.a` 里住着 `__va_start` 那一族、`_start`、
 * 长除法那些辅助函数，少一个都链不出东西来。这一片照 `tccelf.c` 的
 * `read_ar_header` / `tcc_load_archive` / `tcc_load_alacarte`。
 *
 * 格式（`<ar.h>`）：`"!<arch>\n"` 之后一个个成员，每个成员前面 60 字节的头：
 *
 *   名字 16 | 时间 12 | uid 6 | gid 6 | 权限 8 | 长度 10 | "`\n" 2
 *
 * 内容按偶数补齐。两格值得记，都是「tcc 就这么简单」：
 *
 *  - 名字**只有 16 字节那一格**，尾部的空格去掉就是名字。GNU 的长名字（`/N` 指
 *    进那张 `//` 表）与 BSD 的 `#1/N` 它都不认 —— 于是它自己造的库里名字都短。
 *  - 符号索引是名叫 `/`（或 `/SYM64/`）的第一个成员，**大端**：先是符号个数，
 *    然后每个符号一个「成员头的偏移」，再接一串以 0 结尾的名字。
 *
 * 按需取用（`tcc_load_alacarte`）是一个**要转圈的**过程：扫一遍索引，凡是名字正好
 * 是当前还未定义的符号，就把那个成员拉进来；拉进来的成员自己又可能带新的未定义符号，
 * 所以要一圈一圈扫到没有新的为止。
 */

import { OmniError } from '../source/diag.js';

const ARMAG = '!<arch>\n';
const HDR_SIZE = 60;
const NAME_LEN = 16;
const SIZE_AT = 48;
const SIZE_LEN = 10;
const FMAG_AT = 58;

function arStr(bytes, at, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

/** 尾部的空格去掉 —— `read_ar_header` 就做这一件事。 */
function trimName(s) {
  let e = s.length;
  while (e > 0 && s[e - 1] === ' ') e--;
  return s.slice(0, e);
}

/** 大端读 `n` 个字节（索引里的个数与偏移都是大端）。 */
function beAt(bytes, at, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + bytes[at + i];
  return v;
}

/**
 * 读一个静态库。
 *
 * @param bytes 整个 `.a`
 * @returns `{index, members}`：`index` 是 `null` 或 `{entry, syms}`（`syms` 每条
 *          `{name, at}`，`at` 是那个成员**头**的偏移，与索引里记的一样）；
 *          `members` 每条 `{name, at, bytes}`，`at` 同样是头的偏移
 */
export function readArchive(bytes) {
  if (arStr(bytes, 0, ARMAG.length) !== ARMAG) throw new OmniError('ar: 开头不是 !<arch>');
  const members = [];
  let index = null;
  let at = ARMAG.length;
  while (at + HDR_SIZE <= bytes.length) {
    if (arStr(bytes, FMAG_AT + at, 2) !== '`\n') throw new OmniError(`ar: 0x${at.toString(16)} 处的成员头不对`);
    const name = trimName(arStr(bytes, at, NAME_LEN));
    const size = parseInt(arStr(bytes, at + SIZE_AT, SIZE_LEN).trim(), 10);
    if (!Number.isFinite(size) || size < 0) throw new OmniError(`ar: 成员 '${name}' 的长度读不出来`);
    const body = bytes.subarray(at + HDR_SIZE, at + HDR_SIZE + size);
    if (name === '/' || name === '/SYM64/') {
      /* 符号索引：大端，先个数，再每个符号一个偏移，再一串名字。 */
      const entry = name === '/' ? 4 : 8;
      const nsyms = beAt(body, 0, entry);
      const syms = [];
      let p = entry + nsyms * entry;
      for (let i = 0; i < nsyms; i++) {
        let e = p;
        while (e < body.length && body[e] !== 0) e++;
        syms.push({ name: arStr(body, p, e - p), at: beAt(body, entry + i * entry, entry) });
        p = e + 1;
      }
      index = { entry, syms };
    } else if (name !== '//') {
      members.push({ name, at, bytes: body });
    }
    at += HDR_SIZE + size + (size % 2);          // 内容按偶数补齐
  }
  return { index, members };
}

/**
 * 按需取用（`tcc_load_alacarte`）：只把「能补上当前未定义符号」的成员拉进来，
 * 一圈一圈扫到没有新的为止。
 *
 * @param ar `readArchive` 的结果
 * @param undef 一个判断：这个名字现在还是未定义吗
 * @param took 一个回调：把这个成员拉进来（调用方自己去并合、去更新未定义集合）
 * @returns 拉进来的成员，按拉进来的次序
 */
export function alacarte(ar, undef, took) {
  if (ar.index === null) throw new OmniError('ar: 这个库没有符号索引，按需取用无从下手');
  const byAt = new Map();
  for (const m of ar.members) byAt.set(m.at, m);
  const done = new Set();
  const out = [];
  for (;;) {
    let bound = 0;
    for (const s of ar.index.syms) {
      if (!undef(s.name)) continue;
      const m = byAt.get(s.at);
      if (m === undefined) throw new OmniError(`ar: 索引里 '${s.name}' 指的 0x${s.at.toString(16)} 不是一个成员`);
      if (done.has(m.at)) continue;
      done.add(m.at);
      out.push(m);
      took(m);
      bound++;
    }
    if (bound === 0) return out;
  }
}
