/* GNU ld 脚本的一个**子集** —— 照 tcc 的 `tcc_load_ldscript`（`tccelf.c:4169`）。
 *
 * 为什么非要它：glibc 的 `/usr/lib/libc.so` **不是一个库**，是一份文本：
 *
 *   GROUP ( /usr/lib/libc.so.6 /usr/lib/libc_nonshared.a  AS_NEEDED ( /usr/lib/ld-linux-x86-64.so.2 ) )
 *
 * 不认它的话 `-lc` 就落不到实处 —— 我们从前是把 `libc.so.6` / `libm.so.6` /
 * `libc_nonshared.a` 的路径**一条条写死在 `cli.js` 里**猜出来的（x86_64 容器里
 * 那三笔账就是这么一条条补上的）。tcc 不猜：它读这份脚本。
 *
 * tcc 认的就这几条（别的都报「unexpected」）：
 *
 *  - `INPUT ( … )` / `GROUP ( … )`：里头一串文件名，`-lfoo` 也算一项；
 *    `GROUP` 与 `INPUT` 的差别在**转圈**（`ld_add_file_list` 末尾那句
 *    `if (c == 'G' && ret == 0 && new_undef_sym(...)) goto repeat`）—— 而我们这一层
 *    只回名字，转圈是 `alacarte` 自己的事（它本来就转到没有新的为止）。
 *  - `AS_NEEDED ( … )`：一样收进来（tcc 的 `c == 'A'` 那一支）。
 *  - `OUTPUT_FORMAT ( … )` / `TARGET ( … )`：括号照样吃掉，内容不要。
 *
 * 名字里认的字符照 `ld_next`：字母数字加 `/.-_+=$:\,~`。注释是 `/* … *\/`。
 */

/** 名字里能出现的那些标点（`ld_next` 的 `strchr("/.-_+=$:\\,~", ch)`）。 */
const LD_NAME_PUNCT = '/.-_+=$:\\,~';

function ldNameChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
    || LD_NAME_PUNCT.indexOf(c) >= 0;
}

/** 记号：`{k}` 是 `'name'` / `'('` / `')'` / `','` / `'eof'`，名字在 `v`。
 *
 * 名字带 `ld` 前缀是因为模块作用域的名字在整份程序里必须唯一（自举那条链会骂）——
 * `wasm/assemble.js` 里已经有一个 `tokens`。 */
function ldTokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') { out.push({ k: c, v: c }); i++; continue; }
    if (!ldNameChar(c)) return null;                  // 不认的字符 = 这不是我们认的脚本
    let j = i;
    while (j < text.length && ldNameChar(text[j])) j++;
    out.push({ k: 'name', v: text.slice(i, j) });
    i = j;
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

/**
 * 读一份 ld 脚本，回里头 `INPUT`/`GROUP`/`AS_NEEDED` 点到的那些名字。
 *
 * @param text 文件内容
 * @returns 名字数组（原样，可能是绝对路径、也可能是 `-lfoo`），或者 `null`
 *          ——「这不是一份我们认的 ld 脚本」（调用方该把它当二进制去读）
 */
export function parseLdScript(text) {
  const ts = ldTokens(text);
  if (ts === null) return null;
  const names = [];
  let i = 0;
  let sawOne = false;
  /** 吃掉一对括号；`take` 为真时把里头的名字收下来（`AS_NEEDED` 递归下去也收）。 */
  const list = (take) => {
    if (ts[i].k !== '(') return false;
    i++;
    for (;;) {
      const t = ts[i];
      if (t.k === 'eof') return false;                // 括号没闭上
      if (t.k === ')') { i++; return true; }
      if (t.k === ',') { i++; continue; }
      if (t.k !== 'name') return false;
      i++;
      if (ts[i].k === '(') {                          // `AS_NEEDED ( … )` 一类
        if (!list(take && t.v === 'AS_NEEDED')) return false;
        continue;
      }
      if (take) names.push(t.v);
    }
  };
  for (;;) {
    const t = ts[i];
    if (t.k === 'eof') break;
    if (t.k !== 'name') return null;
    i++;
    const cmd = t.v;
    if (cmd === 'INPUT' || cmd === 'GROUP') {
      if (!list(true)) return null;
    } else if (cmd === 'OUTPUT_FORMAT' || cmd === 'TARGET') {
      if (!list(false)) return null;
    } else if (!sawOne) {
      return null;                                    // 头一条就不认识 = 不是脚本
    } else {
      return null;                                    // tcc 这儿是报错，我们回「不认」
    }
    sawOne = true;
  }
  return sawOne ? names : null;
}
