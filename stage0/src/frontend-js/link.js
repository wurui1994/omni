// Omni stage0 — JS 的模块链接（ADR-0011 落地顺序第 6e 步）
//
// 立场：**不给 OIR 加模块**。ESM 的语义在这里只是"哪个名字来自哪个文件"，而两个后端
// 都只发一个编译单元（一个 .c / 一个 .mjs）。所以 import/export 在降级之前就解决掉：
// 从入口出发把依赖收全、按依赖序拼成一个 Program、把 import/export 的外壳拆掉。
// 于是 lower.js 完全不需要知道模块这回事（它见到 import 仍然是报错的，那是安全网）。
//
// 几条刻意的限制（都是量过源码之后定的）：
//   - 只有具名导入（`import { a, b } from './m.js'`）；默认导入、`* as` 命名空间导入、
//     `export default`、`export … from …` 全部报错 —— 量过：仓库里一处都没有。
//   - `import { a as b }` 摊成模块级的 `const b = a;`（不做重命名，也就不需要作用域分析）。
//   - 模块级的名字**跨文件重名就报错**：拼在一起之后它们是同一个作用域。改名比在这里
//     做一遍带作用域的重写便宜得多，而且改完源码更好读。
//   - `node:*` 的导入一律报错，让它去走封闭 ABI（ADR-0011 决策 2）。

import { parseJs } from './parser.js';
import { SourceFile } from '../source/diag.js';
import { C_ABI } from '../hir/c_abi.js';

/**
 * 原生模块（ADR-0011 决策 17）：`src/host/native.js` 里的每个导出对应一个 ABI op。
 * 这个文件**不会**被拼进程序 —— 它在 node 上是真实现，降级之后就是那个 op。
 * 表在这里而不在 lower.js：只有链接器知道"这个名字是从哪个文件导入来的"。
 */
const NATIVE_SUFFIX = 'src/host/native.js';

/**
 * 外部 C 符号（ADR-0014 决策 4）：`src/host/native_c.js` 里的每个导出对应 `C_ABI` 里
 * 一条。和上面那条同一个套路，区别只在另一端是**别人的**共享库而不是我们的运行时。
 * node 宿主上那份实现是抛错的 —— C-ABI 只存在于原生构建。
 */
const CABI_SUFFIX = 'src/host/native_c.js';

const NATIVE_OPS = {
  readText: 'js_fs_read_text',
  writeText: 'js_fs_write_text',
  exists: 'js_fs_exists',
  readDir: 'js_fs_readdir',
  mtimeMs: 'js_fs_mtime_ms',
  fileSize: 'js_fs_size',
  mkdTemp: 'js_fs_mkdtemp',
  mkdirAll: 'js_fs_mkdir_all',
  rename: 'js_fs_rename',
  realPath: 'js_fs_realpath',
  args: 'js_proc_args',
  cwd: 'js_proc_cwd',
  env: 'js_proc_env',
  stdout: 'js_proc_stdout_write',
  stderr: 'js_proc_stderr_write',
  setExitCode: 'js_proc_exit_code',
  stdinIsTty: 'js_proc_stdin_is_tty',
  readLine: 'js_proc_read_line',
  spawn: 'js_proc_spawn',
  tmpDir: 'js_os_tmpdir',
  nowMs: 'js_now_ms',
  installDir: 'js_install_dir',
  evalJs: 'js_eval',
  evalCaptured: 'js_eval_captured',
  hasJsEngine: 'js_has_engine',
  typeTag: 'js_type_tag',
  fmtReal: 'js_fmt_real',
  fmtRealG: 'js_fmt_real_g',
  // `%f` / `%e` / `%g` 那三种排版（ADR-0016 第八刀 / 第三十刀 / 第三十一刀）。解释器上
  // `(sfix …)` / `(ssci …)` / `(sgen …)` 走它们 —— 与 fmtReal 同一条纪律：在哪个宿主上就用
  // 那个宿主已有的那一份（prelude 的 $str_fixed 那几个、runtime 的 omni_str_fixed 那几个）。
  fmtFixed: 'js_fmt_fixed',
  fmtSci: 'js_fmt_sci',
  fmtGen: 'js_fmt_gen',
  reprReal: 'js_repr_real',
  callJsOp: 'js_call_op',
  wrapFn: 'js_wrap_fn',
  callFnValue: 'js_call_fn',
};


/** posix 风格的 dirname：这个文件自己将来也要被降级，所以不碰宿主的 path */
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

/** 把 './x.js' / '../y/z.js' 归一化到一个干净的路径 */
function resolvePath(base, rel) {
  const parts = (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '.') continue;
    if (p === '' && i > 0) continue;
    if (p === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join('/');
}

/** 一条声明在模块作用域里绑了哪些名字 */
function declNames(s, out = []) {
  switch (s.type) {
    case 'FuncDecl': case 'ClassDecl': out.push(s.id); break;
    case 'VarDecl':
      for (const d of s.decls) bindingNames(d.id, out);
      break;
    default: break;
  }
  return out;
}

function bindingNames(pat, out) {
  if (!pat) return out;
  switch (pat.type) {
    case 'Ident': out.push(pat.name); break;
    case 'AssignPattern': bindingNames(pat.left, out); break;
    case 'ArrayPattern':
      for (const el of pat.elements) bindingNames(el, out);
      bindingNames(pat.rest, out);
      break;
    case 'ObjectPattern':
      for (const p of pat.props) bindingNames(p.value, out);
      bindingNames(pat.rest, out);
      break;
    default: break;
  }
  return out;
}

/**
 * 一个模块：拆掉 import/export 之后的 body、导出表、依赖表。
 * @param {any} m
 * @param {import('../source/diag.js').Diagnostics} diags
 */
function scan(m, diags) {
  const base = dirOf(m.path);
  for (const s of m.ast.body) {
    switch (s.type) {
      case 'ImportDecl': {
        if (s.source.startsWith('node:')) {
          diags.error(s.span, `'${s.source}' is not importable; use the closed ABI (ADR-0011 decision 2)`);
          break;
        }
        if (!s.source.startsWith('.') && !s.source.startsWith('/')) {
          diags.error(s.span, `'${s.source}' is not a relative module path`);
          break;
        }
        for (const sp of s.specifiers) {
          if (sp.kind !== 'named') {
            diags.error(s.span, `only named imports are supported (found a ${sp.kind} import)`);
          }
        }
        const target = resolvePath(base, s.source);
        // 原生模块：只登记"名字 -> op"，文件本身不加载、不拼进来
        if (target.endsWith(NATIVE_SUFFIX)) {
          for (const sp of s.specifiers) {
            if (sp.kind !== 'named') continue;
            const op = NATIVE_OPS[sp.imported];
            if (!op) {
              diags.error(s.span, `'${sp.imported}' is not part of the native host surface`);
              continue;
            }
            m.natives.push({ local: sp.local, op, span: s.span });
          }
          break;
        }
        if (target.endsWith(CABI_SUFFIX)) {
          for (const sp of s.specifiers) {
            if (sp.kind !== 'named') continue;
            if (!C_ABI[sp.imported]) {
              diags.error(s.span, `'${sp.imported}' is not in the C ABI table (ADR-0014 decision 4)`);
              continue;
            }
            m.cnatives.push({ local: sp.local, entry: sp.imported, span: s.span });
          }
          break;
        }
        m.imports.push({ path: target, specs: s.specifiers, span: s.span });
        break;
      }
      case 'ExportDecl': {
        const names = declNames(s.decl);
        if (!names.length) diags.error(s.span, 'this declaration cannot be exported');
        for (const n of names) m.exports.set(n, n);
        m.body.push(s.decl);
        break;
      }
      case 'ExportNamed': {
        if (s.source) {
          diags.error(s.span, "'export … from …' is not supported; import it and export it again");
          break;
        }
        for (const sp of s.specifiers) {
          if (sp.local !== sp.exported) {
            diags.error(s.span, `renaming an export ('${sp.local}' as '${sp.exported}') is not supported`);
            continue;
          }
          m.exports.set(sp.exported, sp.local);
        }
        break;
      }
      case 'ExportDefault':
        diags.error(s.span, "'export default' is not supported; use a named export");
        break;
      default:
        m.body.push(s);
        break;
    }
  }
}

/**
 * 从入口出发，把整棵 import 树拼成一个 Program。
 * @param {string} entry 入口文件的路径（归一化过的）
 * @param {(path: string) => (string|null)} read 读文件；读不到给 null
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {{type:'Program', body:any[], modules:string[]}}
 */
export function linkJs(entry, read, diags) {
  const mods = new Map();
  const state = new Map();
  const order = [];

  const load = (path, span) => {
    const st = state.get(path);
    if (st === 'done') return;
    if (st === 'loading') {
      diags.error(span, `import cycle through '${path}'`);
      return;
    }
    const text = read(path);
    if (text === null || text === undefined) {
      diags.error(span, `cannot read module '${path}'`);
      state.set(path, 'done');
      return;
    }
    state.set(path, 'loading');
    const m = { path, ast: parseJs(new SourceFile(path, text), diags), body: [], exports: new Map(), imports: [], natives: [], cnatives: [] };
    mods.set(path, m);
    scan(m, diags);
    for (const imp of m.imports) load(imp.path, imp.span);
    state.set(path, 'done');
    order.push(m);   // 后序：依赖排在自己前面
  };

  load(entry, null);

  // 模块级的名字拼在一起就是同一个作用域，重名必须当场报错
  const owner = new Map();
  for (const m of order) {
    for (const s of m.body) {
      for (const n of declNames(s)) {
        const prev = owner.get(n);
        if (prev && prev !== m.path) {
          diags.error(s.span, `'${n}' is declared at module scope in both '${prev}' and '${m.path}'; rename one`);
        }
        owner.set(n, m.path);
      }
    }
  }

  const body = [];
  const natives = new Map();
  const cnatives = new Map();
  for (const m of order) {
    for (const n of m.cnatives) {
      const prev = cnatives.get(n.local);
      if (prev && prev !== n.entry) {
        diags.error(n.span, `'${n.local}' is bound to two different C symbols; rename one`);
        continue;
      }
      cnatives.set(n.local, n.entry);
    }
    for (const n of m.natives) {
      const prev = natives.get(n.local);
      if (prev && prev !== n.op) {
        diags.error(n.span, `'${n.local}' is bound to two different native ops; rename one`);
        continue;
      }
      natives.set(n.local, n.op);
    }
    for (const imp of m.imports) {
      const target = mods.get(imp.path);
      if (!target) continue;   // 读不到，上面已经报过
      for (const sp of imp.specs) {
        if (sp.kind !== 'named') continue;
        if (!target.exports.has(sp.imported)) {
          diags.error(imp.span, `'${imp.path}' does not export '${sp.imported}'`);
          continue;
        }
        // 别名摊成一句模块级的绑定：不重命名，也就不需要作用域分析
        if (sp.local !== sp.imported) {
          body.push({
            type: 'VarDecl',
            kind: 'const',
            decls: [{
              id: { type: 'Ident', name: sp.local, span: imp.span },
              init: { type: 'Ident', name: sp.imported, span: imp.span },
            }],
            span: imp.span,
          });
        }
      }
    }
    body.push(...m.body);
  }
  return { type: 'Program', body, natives, cnatives, modules: order.map((m) => m.path) };
}
