/**
 * 命令树（ADR-0018 决策四）。
 *
 * 从前 `cli.js` 是一个 28 条分支的 `switch`，外加一坨**顶层预解析**——为了别把 `-I dir`
 * 里的 `dir` 当成源文件，顶层硬编码了全程序每一个带值开关（`--image-base` 是 PE 独有的、
 * `--install-name` 是 Mach-O 独有的、`-isystem` 是 C 独有的，全都写在那个与语言无关的
 * 位置上）。那就是耦合的物理形式：加一个 PE 链接器的开关要改顶层。
 *
 * 这一份把「一条命令认识哪些开关」搬到**那条命令自己身上**，于是：
 *
 *   - 顶层不再认识任何一门语言特有的开关
 *   - `--help` 在**任何一级**都由同一个函数生成（走到那个节点，印它自己的那份）
 *   - 将来的 shell 补全、`--help --json` 是同一棵树上的另一个渲染器
 *
 * 一个节点：
 *
 *   {
 *     name:  'link',
 *     brief: '一行说明（父节点的清单里印这一行）',
 *     usage: 'FILE.o... -o OUT'      // 省略时按有没有 children 猜
 *     help:  '多行详述（可省）',
 *     flags: [{ name: '-o', alias: '--output', arity: 1, brief: '…' }],
 *     run:   (ctx) => number,        // ctx = { argv, opts, args, path }
 *     children: [ … ],               // 有 children 的是**组**，没有的是叶子
 *     hidden: true,                  // 旧名的静默别名：能用、不进清单（决策六）
 *   }
 *
 * 这一份**不碰宿主**：没有 IO、没有 process。报错走传进来的 `err`（`cli.js` 给
 * `OmniError`），印字由调用方拿着字符串去印。于是它能被单独测。
 */

/** 每一级都认的那几个（`-h` 在任何一级都要能用，不然多级 `--help` 就是空话）。 */
export const GLOBAL_FLAGS = [
  { name: '--verbose', alias: '-v', arity: 0, brief: '把每一步与它的耗时打到 stderr' },
  { name: '--explain', arity: 0, brief: '印出将要走的管线，然后停（不写盘、不执行）' },
  { name: '--help', alias: '-h', arity: 0, brief: '印这一级的用法' },
  /* 这两格由 `cli.js` 的 `main` 在 `findCmd` **之前**剥掉（命令树按"第一个词是不是
     动词"走，前缀里的开关会被拦在门口）。摆进这张表只为两件事：`--help` 里列得出来、
     写在动词后面时 `splitArgv` 不当场骂。见 docs/design/omni-serve-studio.md §3。 */
  { name: '--client', arity: 0, brief: '把这条命令发给 omni serve 去跑' },
  { name: '--server', arity: 1, value: 'URL', brief: '默认 http://127.0.0.1:7111 / OMNI_SERVER' },
];

/**
 * 一个记号在**这个节点**上是哪一格开关。
 *
 * 回 `{ key, arity, glued }`：`key` 是规范名（`-o` 与 `--output` 归到 `flags` 里那个
 * `name`），`glued` 是「值粘在名字后面」时的那个值（`-Ifoo` 的 `foo`），没粘就是 `null`。
 * 不认识回 `null`。
 */
function matchFlag(node, tok) {
  const table = [...(node.flags ?? []), ...GLOBAL_FLAGS];
  for (const f of table) {
    if (f.name === tok || f.alias === tok) return { key: f.name, arity: f.arity, glued: null };
  }
  /* 一个节点把 `-v` 当 **tcc 的 `-v`** 用时（`omni c cpp`），那一格是**数出来**的：
   * tcc 里 `do ++verbose; while (*optarg++ == 'v')`，于是 `-vvv` 也合法、而且要能一直往上。
   * 表里只列到 `-vv`（`--help` 印两行就够），所以这条规则在这儿，不在表里。 */
  if (/^-v+$/.test(tok) && table.some((f) => f.name === '-v')) {
    return { key: '-v', arity: 0, glued: null };
  }
  /* 值**粘在名字后面**（`-Ifoo`、`-DM=1`、`-UX`）—— tcc 两种写法都收，所以我们也收
   * （`cli.js` 的 `incDirs`/`defArgs` 本来就在拆这种）。只有带值的那些能这么写；
   * 长名字优先，免得将来加了 `-I` 与 `-Ifoo` 这种前缀关系时挑错。 */
  let best = null;
  for (const f of table) {
    if (f.arity !== 1) continue;
    if (!tok.startsWith(f.name) || tok.length === f.name.length) continue;
    if (best === null || f.name.length > best.name.length) best = f;
  }
  if (best !== null) return { key: best.name, arity: 1, glued: tok.slice(best.name.length) };
  return null;
}

/**
 * 沿着 argv 往下走，找到要跑的那个节点。
 *
 * `omni c link a.o -o x` -> `{ node: link, path: ['c','link'], rest: ['a.o','-o','x'] }`
 *
 * 走到**第一个不是子命令名**的记号就停。所以 `omni c --help` 落在 `c` 上、
 * `omni c link --help` 落在 `link` 上 —— 多级 `--help` 就是这么来的，不必特判。
 */
export function findCmd(root, argv) {
  let node = root;
  const path = [];
  let i = 0;
  while (i < argv.length) {
    const kids = node.children;
    if (kids === undefined || kids.length === 0) break;
    const hit = kids.find((k) => k.name === argv[i] || (k.aka ?? []).includes(argv[i]));
    if (hit === undefined) break;
    node = hit;
    path.push(argv[i]);
    i++;
  }
  return { node, path, rest: argv.slice(i) };
}

/**
 * 把一条命令的 argv 分成「开关」与「位置参数」。
 *
 * `opts` 是 `Map<规范名, 值数组>`——`-o` 与 `--output` 归到同一个键（`flags` 里的 `name`），
 * 重复给的（`-I a -I b`）按顺序攒着，不带值的攒 `true`。
 *
 * **不认识的开关直接骂**（ADR-0018 分片 4）。从前是「先放过、当 arity 0」，那是分片 1
 * 「行为零变化」的过渡态，代价有两层：
 *
 *   - 打错一个开关名会**悄悄按默认走**。量到过一次：`c obj -f elf` 出来是 Mach-O
 *     （那次是别名没铺平）。门这时候比的是「我们两趟自己」，两趟都错得一样，于是绿。
 *   - 带值的开关不认识时，它那个**值会被当成位置参数**（= 一个源文件/输入 `.o`）。
 *     这一格在链接器上尤其毒：多一个输入文件，符号表就多一份。
 *
 * `c tcc` 那个节点故意不声明 flags（tcc 的 `-v`/`-r`/`-f` 与 omni 的不同义，它自己一套
 * 解析器），所以 `cli.js` 在调这一步**之前**就把它岔开了。
 *
 * `--` 之后的一律是位置参数（`omni c run t.c -- argv1 argv2`），原样留在 `args` 里，
 * 前面那个 `--` 也留着 —— 现有那几条实现自己在找它。
 */
export function splitArgv(node, rest, err) {
  const opts = new Map();
  const args = [];
  let passthrough = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (passthrough) { args.push(a); continue; }
    if (a === '--') { passthrough = true; args.push(a); continue; }
    if (a.length > 1 && a.startsWith('-')) {
      const m = matchFlag(node, a);
      if (m === null) {
        /* 骂的时候把这一条认识的都列出来 —— 打错名字最常见的下一步就是「那它叫什么」。 */
        const known = [...(node.flags ?? []), ...GLOBAL_FLAGS].map((f) => f.name).join(' ');
        throw err(`不认识的开关 '${a}'；'${node.name}' 认识的是：${known}`);
      }
      const cur = opts.get(m.key) ?? [];
      if (m.glued !== null) cur.push(m.glued);
      else if (m.arity === 1) {
        if (i + 1 >= rest.length) throw err(`${a} 后面缺一个值`);
        cur.push(rest[i + 1]);
        i++;
      } else cur.push(true);
      opts.set(m.key, cur);
      continue;
    }
    args.push(a);
  }
  return { opts, args };
}

/** 一个开关印成一行左边那一半：`-o, --output NAME`。 */
function flagLabel(f) {
  const names = f.alias === undefined ? f.name : `${f.alias}, ${f.name}`;
  return f.arity === 1 ? `${names} ${f.value ?? 'VALUE'}` : names;
}

/* 名字带 `Cell` 是为了不与 `mir/print.js` 里那个 `pad` 撞 —— JS 前端把 import 树链成
 * 一份程序，模块作用域的名字在整份程序里必须唯一（自举那条链会骂）。 */
function padCell(s, n) {
  let out = s;
  while (out.length < n) out += ' ';
  return out;
}

/**
 * 这一级的 `--help`。组印子命令清单，叶子印开关。
 *
 * 两种节点印出来的形状故意不同：组是「往下还有哪些」，叶子是「这一条怎么用」。混成一份
 * 就又变成从前那两百行全量倾倒了。
 */
export function renderHelp(node, path) {
  const full = ['omni', ...path].join(' ');
  const out = [];
  out.push(node.brief === undefined ? full : `${full} — ${node.brief}`);
  out.push('');

  const kids = (node.children ?? []).filter((k) => k.hidden !== true);
  if (kids.length > 0) {
    out.push(`usage: ${full} <command> [args...]`);
    out.push('');
    out.push('commands:');
    let w = 0;
    for (const k of kids) if (k.name.length > w) w = k.name.length;
    for (const k of kids) out.push(`  ${padCell(k.name, w + 2)}${k.brief ?? ''}`);
  } else {
    out.push(`usage: ${full} ${node.usage ?? '[args...]'}`);
  }

  if (node.help !== undefined) {
    out.push('');
    out.push(node.help.replace(/\n+$/, ''));
  }

  const fs = node.flags ?? [];
  if (fs.length > 0) {
    out.push('');
    out.push('flags:');
    let w = 0;
    for (const f of fs) { const l = flagLabel(f); if (l.length > w) w = l.length; }
    for (const f of fs) out.push(`  ${padCell(flagLabel(f), w + 2)}${f.brief ?? ''}`);
  }

  out.push('');
  out.push('global flags:');
  {
    let w = 0;
    for (const f of GLOBAL_FLAGS) { const l = flagLabel(f); if (l.length > w) w = l.length; }
    for (const f of GLOBAL_FLAGS) out.push(`  ${padCell(flagLabel(f), w + 2)}${f.brief ?? ''}`);
  }

  if (kids.length > 0) {
    out.push('');
    out.push(`每一条子命令自己也有 --help：${full} <command> --help`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * 把别名换成规范名，次序与 `--` 之后的东西一个字节都不动。
 *
 * 为什么要这一步：底下那 28 段实现是**自己在 `rest` 上找**开关的（`rest.indexOf('--format')`
 * 那种）。新加的短写法（`-f` = `--format`）它们不认识 —— 量到过：`c obj -f elf` 出来的是
 * Mach-O，因为那一段找不到 `--format` 就走了默认。所以在交给它们之前先把别名铺平。
 *
 * 分片 4 把实现改成吃 `opts` 那张表之后，这一步就该删掉。
 */
export function canonicalize(node, rest) {
  const own = new Set((node.flags ?? []).map((f) => f.name));
  const out = [];
  let passthrough = false;
  for (const a of rest) {
    if (passthrough) { out.push(a); continue; }
    if (a === '--') { passthrough = true; out.push(a); continue; }
    /* **这个节点自己声明的名字不动**。要紧的一格：`omni c cpp -v` 里那个 `-v` 是 **tcc 的
     * `-v`**（印搜索路径），不是 omni 的 `--verbose` —— 量到过：铺平成 `--verbose` 之后
     * `inc/01-include -v` 那一条直接红了。节点级压过全局级，这也是 `omni c tcc` 能自己
     * 一套解析器的同一条道理。 */
    if (own.has(a)) { out.push(a); continue; }
    let tok = a;
    for (const f of [...(node.flags ?? []), ...GLOBAL_FLAGS]) {
      if (f.alias === a) { tok = f.name; break; }
    }
    out.push(tok);
  }
  return out;
}

/** 这个节点自己把 `-v` 当别的意思用了吗（那就不能拿它当 `--verbose`）。 */
export function ownsVerbose(node) {
  return (node.flags ?? []).some((f) => f.name === '-v');
}

/** 旧名到新名的对照表（决策六：别名是**静默**的，只在这儿列出来）。 */
export function renderLegacy(pairs) {
  const out = ['旧的扁平命令名仍然可用（静默别名），对应关系：', ''];
  let w = 0;
  for (const [old] of pairs) if (old.length > w) w = old.length;
  for (const [old, now] of pairs) out.push(`  ${padCell(old, w + 2)}omni ${now}`);
  out.push('');
  out.push('新写的脚本与门请用右边那一栏 —— 左边这些会在 ADR-0018 分片 4 里删掉。');
  return `${out.join('\n')}\n`;
}
