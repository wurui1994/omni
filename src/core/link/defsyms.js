/* **符号预设**（`.def`）：一份文本，说「这个库存在，它有这些名字」。
 *
 * 为什么要它：交叉编译的时候目标平台的那些库**不在这台机器上**。tcc 的 win32 那一路
 * 早就是这么干的 —— `win32/lib/*.def` 加 `win32/include`，于是在 Linux 上也能出
 * `.exe`（`tcc_add_library` 在 PE 上找的第一样东西就是 `%s/lib%s.def`）。
 * 我们借它的形式，铺到另外两个格式上：
 *
 *   ; 注释（`;` 或 `#` 起头的一行）
 *   LIBRARY libc.so.6
 *   EXPORTS
 *   printf
 *   stdout DATA 8
 *
 *  - `LIBRARY` 是**装载时要的那个名字**（ELF 的 `DT_NEEDED` / Mach-O 的
 *    `LC_LOAD_DYLIB` 里写的就是它），不是文件名。
 *  - `EXPORTS` 之后一行一个名字。名字后面可以跟 `DATA <字节数>` —— 那一格不是
 *    装饰：ELF 上**数据符号要 copy 重定位**（`bind_exe_dynsyms` 在自己的 `.bss` 里
 *    划一块、放一条 `R_*_COPY`），而划多大得从库里问。真的 `.so` 里那是 `st_size`；
 *    没有库可问的时候只能由这一份说（量到过：`stdout` 少了这一格，装载时报
 *    `undefined symbol: stdout`）。
 *  - 名字**照目标格式的写法**：Mach-O 上前面那条下划线要自己带（`_printf`），
 *    ELF 上不带。这一层不猜前缀 —— 前缀是格式的事实，写在文件里最清楚。
 *
 * 这一份只管**文本**。变成 ELF 的 `.dynsym` 条目还是 Mach-O 的导出表，由各自那一侧
 * 的链接器做（`elf_exe.js` 的 `defToDll`、`macho_exe.js` 的 `machoLoadDef`）——
 * 同一份形式，两套形状。
 */

import { OmniError } from '../source/diag.js';

/**
 * 认一份 `.def` 吗？（头几个非空非注释的字符是 `LIBRARY`）
 *
 * 调用方靠它分派：一个文件先看是不是二进制库，不是就问这一句，还不是才当别的文本
 * （Mach-O 那一侧的 `.tbd`）。
 */
export function isDefSyms(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith(';') || t.startsWith('#')) continue;
    return t.startsWith('LIBRARY');
  }
  return false;
}

/**
 * 读一份 `.def`。
 *
 * @param text 文件内容
 * @param where 出错时报的位置（路径）
 * @returns `{soname, syms}`，`syms` 每条 `{name, data, size}`（`data` 为真时 `size`
 *          是字节数，函数那些 `data` 是 `false`、`size` 是 0）
 */
export function parseDefSyms(text, where) {
  let soname = null;
  const syms = [];
  let inExports = false;
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LIBRARY') {
      if (parts[1] === undefined) throw new OmniError(`${where}:${lineNo}: LIBRARY 后面要一个库名`);
      soname = parts[1];
      continue;
    }
    if (parts[0] === 'EXPORTS') { inExports = true; continue; }
    if (!inExports) throw new OmniError(`${where}:${lineNo}: '${parts[0]}' 在 EXPORTS 之前`);
    /* 一个名字，后面可选 `DATA <字节数>`。别的记法一律骂 —— 悄悄放过一行的代价是
     * 「符号明明写了却找不着」，那比当场报错难查得多。 */
    if (parts.length === 1) {
      syms.push({ name: parts[0], data: false, size: 0 });
      continue;
    }
    if (parts[1] !== 'DATA' || parts.length > 3) {
      throw new OmniError(`${where}:${lineNo}: 只认 '名字' 或 '名字 DATA 字节数'，给的是 '${line}'`);
    }
    const n = parts[2] === undefined ? 0 : Number(parts[2]);
    if (!Number.isInteger(n) || n <= 0) {
      throw new OmniError(`${where}:${lineNo}: DATA 后面要一个正的字节数（copy 重定位要划那么大一块）`);
    }
    syms.push({ name: parts[0], data: true, size: n });
  }
  if (soname === null) throw new OmniError(`${where}: 这一份里没有 LIBRARY`);
  return { soname, syms };
}
