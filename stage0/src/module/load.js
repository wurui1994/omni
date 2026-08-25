// Omni stage0 — 模块加载与路径解析（ADR-0009）
//
// 只有两类 specifier，没有第三类，也没有回退：
//
//   相对    "./util.omni"  "../lib/x.omni"   相对**导入方文件所在目录**解析，仅此一处
//   包       "std/json.omni"                  包名经清单查到根目录，再拼后面的相对部分
//
// 刻意不做的事（每一条都有语言踩过的坑，见 ADR-0009）：
//   - 不做隐式相对导入（Python 2）：不以 ./ 开头就一定是包名，不会先试本地再试全局
//   - 不向上逐级查找（node_modules）：解析结果只由「导入方路径 + 清单」决定，与祖先目录无关
//   - 不猜后缀、不找目录索引（node）：路径必须写全 .omni/.omnid/.omnis —— 后缀同时决定类型模式，
//     猜后缀就等于猜模式
//   - 不允许 URL 与绝对路径（Go 早期）：导入路径不是下载地址，也不能绑定某台机器的目录布局
//   - 不做有序搜索路径（Java classpath）：没有"先找到的赢"，同名冲突不会静默生效
//   - 模块身份 = realpath：符号链接与 ./a/../b 指向同一文件时，是同一个模块，只加载一次
//   - 大小写必须与磁盘上的名字逐字节一致：mac/Windows 不区分大小写，不查就是 CI 才炸
//   - 相对路径不能逃出包根：../../ 爬到包外面就不再是这个包的一部分了
//   - 禁止环：报出整条环路径，而不是给一个半初始化的模块

import { readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, basename } from '../host/path.js';
import { fileURLToPath } from 'node:url';
import { SourceFile, OmniError } from '../source/diag.js';
import { parse } from '../parse/parser.js';

const LIB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib');

/** 内置清单。将来会被真正的项目清单文件取代，但形态不变：名字 -> 根目录，一层间接，没有搜索。 */
export const PACKAGES = new Map([['std', LIB_DIR]]);

/** 文件后缀决定该文件的类型模式（ADR-0008 第 1 节）。模式是**按文件**的。 */
export const MODE_BY_EXT = { '.omni': 'mixed', '.omnid': 'dynamic', '.omnis': 'static' };

const EXTS = Object.keys(MODE_BY_EXT);

export function modeOfPath(path, fallback = 'mixed') {
  const dot = path.lastIndexOf('.');
  return (dot < 0 ? undefined : MODE_BY_EXT[path.slice(dot)]) ?? fallback;
}

class ResolveError extends Error {}

const fail = (msg) => { throw new ResolveError(msg); };

/**
 * 诊断里显示的路径。模块**身份**是 realpath（唯一性靠它），但 realpath 又长又和某台机器绑定：
 * 照原样印进诊断，别的机器上没法对照，快照测试也立刻失效。所以一律显示 cwd 相对路径。
 */
function display(p) {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
}

/** specifier 的形态检查。所有拒绝都在这里，且都给出"该怎么写"，不给出"我又试了哪些地方"。 */
function classify(spec) {
  if (spec === '') fail('module path is empty');
  if (/:\/\//.test(spec)) fail(`module path must not be a URL: '${spec}' — depend on a package name, not a download address`);
  if (spec.includes('\\')) fail(`module path must use '/' as separator, not '\\': '${spec}'`);
  if (isAbsolute(spec) || /^[A-Za-z]:/.test(spec)) fail(`module path must not be absolute: '${spec}'`);

  const rel = /^\.\.?\//.test(spec);
  if (!rel && spec.startsWith('.')) fail(`relative module path must start with './' or '../': '${spec}'`);

  const segs = spec.split('/');
  const lead = rel ? segs.findIndex((s) => s !== '.' && s !== '..') : 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === '') fail(`module path has an empty segment: '${spec}'`);
    if (i >= lead && (s === '.' || s === '..')) {
      fail(`'.' and '..' are only allowed at the start of a module path: '${spec}'`);
    }
  }

  if (!EXTS.some((e) => spec.endsWith(e))) {
    fail(`module path must name a file with its extension (${EXTS.join(', ')}): '${spec}'`
      + ' — the extension also selects the type mode, so guessing it would mean guessing the mode');
  }

  if (rel) return { kind: 'relative', tail: spec };
  const slash = spec.indexOf('/');
  if (slash < 0) {
    fail(`'${spec}' is not a module path: a path without '/' would be a package name with nothing after it`
      + ` — write './${spec}' for a file next to this one, or 'pkg/${spec}' for a file in package 'pkg'`);
  }
  const pkg = spec.slice(0, slash);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(pkg)) fail(`invalid package name '${pkg}' in module path '${spec}'`);
  return { kind: 'package', pkg, tail: spec.slice(slash + 1) };
}

/** 大小写逐字节核对：realpath 在不区分大小写的文件系统上不会帮我们纠正 basename。 */
function checkCase(path) {
  let cur = path;
  const parts = [];
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) break;
    parts.push([parent, basename(cur)]);
    cur = parent;
  }
  for (const [parent, name] of parts.reverse()) {
    let entries;
    try { entries = readdirSync(parent); } catch { return; }
    if (entries.includes(name)) continue;
    const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    if (hit) fail(`module path case does not match the file on disk: '${name}' vs '${hit}' in ${display(parent)}`);
    return; // 不存在，交给上层报 "no such module"
  }
}

/**
 * @param {string} spec  import 里写的路径
 * @param {{dir: string, root: string}} from  导入方所在目录与其包根
 * @returns {{path: string, root: string}} 解析后的真实路径与被导入模块所属的包根
 */
function resolveSpec(spec, from) {
  const c = classify(spec);
  const root = c.kind === 'package' ? PACKAGES.get(c.pkg) : from.root;
  if (c.kind === 'package' && !root) {
    fail(`unknown package '${c.pkg}' in module path '${spec}'`
      + ` (known packages: ${[...PACKAGES.keys()].sort().join(', ')})`);
  }
  const path = c.kind === 'package' ? join(root, c.tail) : resolve(from.dir, c.tail);
  const inside = relative(root, path);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    fail(`module path '${spec}' escapes the package root ${display(root)}`);
  }
  checkCase(path);
  if (!existsSync(path)) fail(`no such module: '${spec}' (looked for ${display(path)})`);
  return { path: realpathSync(path), root: realpathSync(root) };
}

/**
 * 从入口开始加载整个模块图，返回拼好的 decls。
 *
 * 拼接是**后序**的：被依赖模块的顶层语句排在依赖方前面，模块级初始化因此天然按
 * 依赖顺序发生 —— 不需要初始化调度器，也不会出现"用到时还没初始化"。
 * 每个 decl 带上 `mod`（所属模块 id）和 `mode`（该文件的类型模式），
 * 检查器靠这两个字段做可见性与按文件的模式（ADR-0008 第 1 节的按文件模式就此落地）。
 *
 * @param {{path: string, text?: string, mode?: string, diags: any}} opts
 *   text 非空表示入口在内存里（REPL）；此时相对导入相对 cwd 解析。
 * @returns {{decls: any[], imports: Map<number, Set<number>>, files: string[]}}
 */
export function loadProgram({ path, text, mode, diags }) {
  /** @type {Map<string, number>} realpath -> 模块 id（完成加载的） */
  const done = new Map();
  /** @type {Map<number, Set<number>>} 模块 id -> 它直接导入的模块 id */
  const imports = new Map();
  /** @type {{real: string, spec: string}[]} DFS 栈，用来报环 */
  const stack = [];
  const files = [];
  const decls = [];
  let nextId = 0;

  /** @returns {number} 模块 id */
  const visit = (real, root, spec, file, fileMode) => {
    const cyc = stack.findIndex((s) => s.real === real);
    if (cyc >= 0) {
      const chain = [...stack.slice(cyc).map((s) => s.spec), spec].join('\n    imports ');
      throw new OmniError(`omni: error: import cycle:\n    ${chain}`);
    }
    const seen = done.get(real);
    if (seen !== undefined) return seen;

    stack.push({ real, spec });
    const src = file ?? new SourceFile(display(real), readFileSync(real, 'utf8'));
    const ast = parse(src, diags);
    const id = nextId++;
    const mine = new Set();
    imports.set(id, mine);
    const dir = dirname(real);

    for (const d of ast.decls) {
      if (d.kind !== 'Import') continue;
      let r;
      try {
        r = resolveSpec(d.path, { dir, root });
      } catch (e) {
        if (!(e instanceof ResolveError)) throw e;
        diags.error(d.pathSpan, e.message);
        continue;
      }
      mine.add(visit(r.path, r.root, d.path, null, modeOfPath(r.path)));
    }

    for (const d of ast.decls) {
      if (d.kind === 'Import') continue;
      d.mod = id;
      d.mode = fileMode;
      decls.push(d);
    }
    files.push(real);
    done.set(real, id);
    stack.pop();
    return id;
  };

  const onDisk = text === undefined && existsSync(path);
  const real = onDisk ? realpathSync(path) : resolve(path);
  const entryFile = onDisk ? null : new SourceFile(path, text ?? '');
  // 入口的包根 = 它自己所在的目录。相对导入不能爬到入口目录之外：入口在哪，包就在哪。
  const root = onDisk ? dirname(real) : process.cwd();
  visit(real, root, path, entryFile, mode ?? modeOfPath(path));
  return { decls, imports, files };
}
