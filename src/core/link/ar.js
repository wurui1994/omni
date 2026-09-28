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
 * BSD（macOS 的 `ar`）那一套与上面 GNU 那一套差三处，都在这儿收：
 *
 *  1. **长名字**：名字那一格写成 `#1/<n>`，真名字在成员**内容的头 n 个字节**里
 *     （尾部用 0 补齐）；头里的长度**包含**那 n 个字节。
 *  2. **符号索引**不叫 `/`，叫 `__.SYMDEF` 或 `__.SYMDEF SORTED`（也走 `#1/` 那一格），
 *     而且是**小端**：`ranlib 数组的字节数` + 一串 `{名字在串表里的偏移, 成员头的偏移}`
 *     + `串表的字节数` + 串表。`__.SYMDEF_64` 那一种每格 8 字节。
 *  3. 成员次序里没有 `//`（长名字表）—— 名字就住在成员自己身上。
 *
 * 为什么要收：macOS 上 `ar rcs` 出来的就是这一套，而"把借来的那份 CPython 打成 `.a`
 * 摞进产物"这条路上第一脚就踩在它上面（我们自己的链接器原来只认 GNU 那一套，
 * 当场报"这个库没有符号索引"）。
 */
const BSD_SYMDEF = new Set(['__.SYMDEF', '__.SYMDEF SORTED', '__.SYMDEF_64', '__.SYMDEF SORTED_64']);

/** 小端读 `n` 个字节（BSD 的索引是小端 —— 与 GNU 正好相反）。 */
function leAt(bytes, at, n) {
  let v = 0;
  for (let i = n - 1; i >= 0; i--) v = v * 256 + bytes[at + i];
  return v;
}

/** 读 BSD 的 `__.SYMDEF`。回 `{entry, syms}`，`syms[i].at` 与 GNU 那一路同一个意思。 */
function bsdSymdef(body, wide) {
  const e = wide ? 8 : 4;
  const ranSize = leAt(body, 0, e);
  const n = Math.floor(ranSize / (e * 2));
  const strAt = e + ranSize + e;              // ranlib 数组之后还有一格"串表多长"
  const syms = [];
  for (let i = 0; i < n; i++) {
    const p = e + i * e * 2;
    const strx = leAt(body, p, e);
    const at = leAt(body, p + e, e);
    let end = strAt + strx;
    while (end < body.length && body[end] !== 0) end++;
    syms.push({ name: arStr(body, strAt + strx, end - (strAt + strx)), at });
  }
  return { entry: e, syms };
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
  let longs = null;                              // GNU 的 `//` 长名字表（有就在成员之前）
  let at = ARMAG.length;
  while (at + HDR_SIZE <= bytes.length) {
    if (arStr(bytes, FMAG_AT + at, 2) !== '`\n') throw new OmniError(`ar: 0x${at.toString(16)} 处的成员头不对`);
    let name = trimName(arStr(bytes, at, NAME_LEN));
    const size = parseInt(arStr(bytes, at + SIZE_AT, SIZE_LEN).trim(), 10);
    if (!Number.isFinite(size) || size < 0) throw new OmniError(`ar: 成员 '${name}' 的长度读不出来`);
    let body = bytes.subarray(at + HDR_SIZE, at + HDR_SIZE + size);
    /* BSD 的长名字：真名字在内容的头 n 个字节里（0 补齐），内容从它后面开始。 */
    if (name.startsWith('#1/')) {
      const n = parseInt(name.slice(3), 10);
      if (!Number.isFinite(n) || n < 0 || n > size) throw new OmniError(`ar: 0x${at.toString(16)} 处的长名字长度不对`);
      let e = 0;
      while (e < n && body[e] !== 0) e++;
      name = arStr(body, 0, e);
      body = body.subarray(n);
    }
    if (name === '/' || name === '/SYM64/') {
      /* GNU 的符号索引：大端，先个数，再每个符号一个偏移，再一串名字。 */
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
    } else if (BSD_SYMDEF.has(name)) {
      index = bsdSymdef(body, name.endsWith('_64'));
    } else if (name === '//') {
      longs = body;
    } else {
      /* GNU 的长名字：名字那格写 `/<偏移>`，真名字在 `//` 表里、以 `/` 或 `\n` 收尾。
       * 从前这一格没做 —— 名字会原样回一个 `/12`（读 Linux 上 `ar` 打的库就露）。 */
      const m = /^\/(\d+)$/.exec(name);
      if (m !== null) {
        if (longs === null) throw new OmniError(`ar: 成员名字是 '${name}'，可没有 // 那张表`);
        const off = Number(m[1]);
        let e = off;
        while (e < longs.length && longs[e] !== 0x2f && longs[e] !== 0x0a) e++;
        name = arStr(longs, off, e - off);
      }
      /* GNU 那一套里名字以 `/` 收尾（`foo.o/`）—— 去掉它，好让"读回来的名字"与
       * 打进去的那个逐字相同（BSD 那一套没有这条尾巴，所以只在有的时候去）。 */
      if (name.endsWith('/')) name = name.slice(0, -1);
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

/* ------------------------------------------------------------ 打一份静态库（第一百四十八片）
 *
 * 为什么要自己会打：macOS 的 `ar` **只认 Mach-O 成员** —— 喂它 ELF 的 `.o` 它一声警告
 * （`not a mach-o file`）就把成员全丢掉，出一份 96 字节的空库（真踩过）。而我们自己那台
 * 链接器吃的正是 ELF 那种 `.o`（tcc 老路：内部表示是 ELF，输出才是 Mach-O），于是
 * "把借来的那份 CPython 打成 `.a` 交给我们自己的链接器"这条路上**没有能用的系统工具**。
 *
 * 出的是 **GNU/SysV 那一套**（我们自己上面那段读得懂，Linux 的 `ar`/`nm` 也读得懂）：
 *   `!<arch>\n` + `/`（符号索引，大端）+ `//`（长名字表）+ 成员，内容按偶数补齐。
 */

/** 60 字节的成员头。名字左对齐补空格，别的字段都是十进制右侧补空格。 */
function arHeader(name, size) {
  const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
  return `${pad(name, NAME_LEN)}${pad('0', 12)}${pad('0', 6)}${pad('0', 6)}${pad('644', 8)}`
    + `${pad(String(size), SIZE_LEN)}\`\n`;
}

/** 大端写 `n` 个字节。 */
function bePut(out, v) {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

const asBytes = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/**
 * 打一份静态库。
 *
 * @param members `[{name, bytes, syms}]` —— `syms` 是**这个成员定义的**那些符号名
 *        （谁定义了什么由调用方说：这一份只管格式，不认得 ELF 也不认得 Mach-O）
 * @returns 整个 `.a` 的字节
 */
export function writeArchive(members) {
  /* 一、长名字表（GNU：名字超过 15 字节的进 `//`，名字那格写 `/<偏移>`）。 */
  let longText = '';
  const nameField = [];
  for (const m of members) {
    if (m.name.length <= NAME_LEN - 1) { nameField.push(`${m.name}/`); continue; }
    nameField.push(`/${longText.length}`);
    longText += `${m.name}/\n`;
  }
  const hasLongs = longText.length > 0;

  /* 二、量偏移：索引那一格的大小只跟符号个数与名字长度有关，所以能先算出来。 */
  const flat = [];
  for (let i = 0; i < members.length; i++) {
    for (const s of members[i].syms ?? []) flat.push({ name: s, i });
  }
  const symBytes = flat.reduce((n, s) => n + s.name.length + 1, 0);
  const idxSize = 4 + flat.length * 4 + symBytes;
  const longSize = longText.length;
  let cur = ARMAG.length + HDR_SIZE + idxSize + (idxSize % 2)
    + (hasLongs ? HDR_SIZE + longSize + (longSize % 2) : 0);
  const memAt = [];
  for (const m of members) {
    memAt.push(cur);
    cur += HDR_SIZE + m.bytes.length + (m.bytes.length % 2);
  }

  /* 三、写。 */
  const parts = [];
  const push = (u8) => { parts.push(u8); };
  push(asBytes(ARMAG));
  push(asBytes(arHeader('/', idxSize)));
  const idx = [];
  bePut(idx, flat.length);
  for (const s of flat) bePut(idx, memAt[s.i]);
  for (const s of flat) { for (const ch of asBytes(s.name)) idx.push(ch); idx.push(0); }
  push(new Uint8Array(idx));
  if (idxSize % 2 === 1) push(new Uint8Array([0x0a]));
  if (hasLongs) {
    push(asBytes(arHeader('//', longSize)));
    push(asBytes(longText));
    if (longSize % 2 === 1) push(new Uint8Array([0x0a]));
  }
  for (let i = 0; i < members.length; i++) {
    push(asBytes(arHeader(nameField[i], members[i].bytes.length)));
    push(members[i].bytes);
    if (members[i].bytes.length % 2 === 1) push(new Uint8Array([0x0a]));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

