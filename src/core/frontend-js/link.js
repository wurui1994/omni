// Omni stage0 — JS 的模块链接（ADR-0011 落地顺序第 6e 步）
//
// 立场：**不给 OIR 加模块**。ESM 的语义在这里只是"哪个名字来自哪个文件"，而两个后端
// 都只发一个编译单元（一个 .c / 一个 .mjs）。所以 import/export 在降级之前就解决掉：
// 从入口出发把依赖收全、按依赖序拼成一个 Program、把 import/export 的外壳拆掉。
// 于是 lower.js 完全不需要知道模块这回事（它见到 import 仍然是报错的，那是安全网）。
//
// 几条刻意的限制（都是量过源码之后定的）：
//   - `export … from …` 与 `export * from …` 都报错，报在写它的那一行上。
//     **"量过：仓库里一处都没有"这句话过期过一次**：`ext/gsl-shell/tograph.js` 与
//     `src/lang/jnc/int-table.js` 后来各写了一句（前者转手 lua 的映射、后者转口
//     `src/lang/common/int.js`）。星号那一句更糟 —— 当时解析器压根不认 `*`，
//     于是它掉进"表达式语句"，报出三条对不上号的错，而真正的红出现在**下游另一个文件**
//     （"does not export 'intConvCode'"）。两句都改成了"先导入再导出"，
//     解析器也认得出 `export *` 了。判据是 `tests/mir/run.js` 那格
//     "编译器自己也要降得下来"：这一族 16 条诊断归零。
//   - `import { a as b }` / `export { x as y }` / `export default …` / `import def` 都摊成模块级
//     的一句绑定（不做重命名，也就不需要作用域分析）；`import * as ns` 摊成一格取值器对象。
//   - 模块级的名字**跨文件重名就报错**：拼在一起之后它们是同一个作用域。改名比在这里
//     做一遍带作用域的重写便宜得多，而且改完源码更好读。
//     **这一条的价钱要按量出来的记**：`cli.js` 那条自编译链上量到过 **142 条**重名
//     （`tests/mir/run.js` 里 `lower/cli.js` 那一格因此是红的，而且这不是新事 ——
//     在 a9df4874 上就有 126 条）。现在**一片一片在还**，还到 **120 条**：
//     `graph/eval.js` 那 9 格（值上的运算 -> `valTruthy` / `valPick` / `valMap*` / `valSlice`
//     · 内部的 `one` / `Env`）· `glr/ebnf.js` 那 3 格（`ebnfGrammarName` /
//     `quoteGrammarStr` / `EbnfRx` —— 与 `yacc.js` 同名却**不同规矩**，这种最该改）·
//     `graph/backend-wat.js` 那 6 格（`WAT_ARITH` / `WAT_CMP` / `WAT_FCMP` 三张表 ·
//     `WatScope` · `watItems` · `retNode`）· 又 4 格（`positionGaps`（与 contract 的
//     `gaps` 是两件事）· `parseWatText` / `WASM_OPS`（wasm 装配那侧）· `cliArg`）。
//     **这几处的共同点是"同名却不同事"** —— `asList` 在 fromtree 里回 null、在 wat 后端里
//     回空数组，这种最该先改。
//     剩下的 120 条分三堆（数出来的）：**ext 那十一份映射 71 条**
//     （`toNode` / `nameOf` / `many` / `OPS` / `PRIM` 在每一门里都是最自然的名字，
//     而 `graph/langs.js` 把十一门**静态**导进来，于是必然撞）· **旧降级 vs 规则那条路
//     14 条**（`frontend-jnc/lower.js` 与 `src/lang/jnc/*`：那是迁移期的重复，migration
//     走完自己就没了，现在改名是给移动靶子上漆）· 剩下 39 条是真正独立同名的。
//     也就是说"改名比作用域重写便宜"这句话对后一堆成立、对 ext 那一堆**不成立**：
//     每加一门语言就多撞几格。要么这一层学会按模块自动改名（那要真的作用域分析），
//     要么 langs.js 改成迟装（`lang/builtin.js` 那三份就是现成的形状）。
//   - `node:*` 的导入一律报错，让它去走封闭 ABI（ADR-0011 决策 2）。

import { parseJs } from './parser.js';
import { SourceFile } from '../source/diag.js';
import { C_ABI } from '../hir/c_abi.js';

/**
 * 原生模块（ADR-0011 决策 17）：`src/host/native.js` 里的每个导出对应一个 ABI op。
 * 这个文件**不会**被拼进程序 —— 它在 node 上是真实现，降级之后就是那个 op。
 * 表在这里而不在 lower.js：只有链接器知道"这个名字是从哪个文件导入来的"。
 */
const NATIVE_SUFFIX = 'core/host/native.js';

/**
 * 外部 C 符号（ADR-0014 决策 4）：`src/host/native_c.js` 里的每个导出对应 `C_ABI` 里
 * 一条。和上面那条同一个套路，区别只在另一端是**别人的**共享库而不是我们的运行时。
 * node 宿主上那份实现是抛错的 —— C-ABI 只存在于原生构建。
 */
const CABI_SUFFIX = 'core/host/native_c.js';

const NATIVE_OPS = {
  readText: 'js_fs_read_text',
  writeText: 'js_fs_write_text',
  exists: 'js_fs_exists',
  readDir: 'js_fs_readdir',
  isDir: 'js_fs_is_dir',
  mtimeMs: 'js_fs_mtime_ms',
  fileSize: 'js_fs_size',
  mkdTemp: 'js_fs_mkdtemp',
  mkdirAll: 'js_fs_mkdir_all',
  rename: 'js_fs_rename',
  removeFile: 'js_fs_remove',
  /* 字节口径那四条（ADR-0017 第八刀）：一个字符一个字节。C 的 libc 走这一组 ——
   * 文本那一组会过 UTF-8 编解码，而这条腿要写出可执行文件。 */
  readBinary: 'js_fs_read_bytes',
  writeBinary: 'js_fs_write_bytes',
  stdoutBytes: 'js_proc_stdout_bytes',
  stderrBytes: 'js_proc_stderr_bytes',
  /* i32 的运算三条（ADR-0013 第三刀）：方言里没有 32 位整数这一格，而解释器要它 ——
   * 理由与 `js_eval`/`js_type_tag` 同类（方言表达不出、两代产物各有一份实现）。 */
  i32Op: 'js_i32_op',
  i32ToU: 'js_i32_tou',
  i32Wrap: 'js_i32_wrap',
  realPath: 'js_fs_realpath',
  args: 'js_proc_args',
  cwd: 'js_proc_cwd',
  env: 'js_proc_env',
  /* 与 `env` 成一对的写那一侧（ADR-0015）：`-f svg` 就是"设宿主的一格" —— 格式因此
   * 不住在任何模块里，同一份产物换个设置再跑就换个输出。 */
  setEnv: 'js_proc_set_env',
  stdout: 'js_proc_stdout_write',
  stderr: 'js_proc_stderr_write',
  setExitCode: 'js_proc_exit_code',
  stdinIsTty: 'js_proc_stdin_is_tty',
  readLine: 'js_proc_read_line',
  spawn: 'js_proc_spawn',
  /* 与 `spawn` 只差一格：把一段文本喂进子进程的 stdin（ADR-0019 决策八）。
   * op 那一侧（`js_abi.js` 的 `js_proc_spawn_in`）早就有，缺的一直是这张表里的名字。 */
  spawnIn: 'js_proc_spawn_in',
  tmpDir: 'js_os_tmpdir',
  nowMs: 'js_now_ms',
  /* 峰值常驻内存（字节）：这条腿上墙上时间的大头常常是内存压力而不是 CPU，
   * 没这一格"慢"就只能靠猜。两个宿主各自把单位换成字节，见 host/native.js。 */
  maxRssBytes: 'js_max_rss',
  /* 插件加载（ADR-0021 S4）：只有 C 那条腿真有，别的腿响着拒 */
  pluginLoad: 'js_plugin_load',
  pluginsOk: 'js_plugin_ok',
  /* `omni run --timeout` 的那一格：两种"跑"（子进程 / 本进程）都只有宿主能中断，
   * 所以时限本身是宿主状态，不是 CLI 里的一个变量。 */
  runTimeout: 'js_run_timeout',
  localStamp: 'js_local_stamp',
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

/* `export default …` 在本模块里落成的那个名字。整棵 import 树是**拼成一个程序**的、顶层
   名字共用一个空间，所以名字里带上模块路径（非字母数字一律换成下划线）。 */
function defaultLocal(path) {
  return `_dflt_${path.replace(/[^A-Za-z0-9]/g, '_')}`;
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
          /* 改名的导出（`export { A as reA }`）：整棵 import 树是**拼成一个程序**的，名字
           * 共用一个顶层空间，所以改名摊成一句模块级绑定 `const reA = A;`（与 import 改名
           * 那一支同一招，见下面 imports 那一段）。导出表记的是"导出名 -> 本地名"，
           * 引用方按导出名找过来，正好落在那一句绑定上。 */
          if (sp.local !== sp.exported) m.aliases.push({ from: sp.local, to: sp.exported, span: s.span });
          m.exports.set(sp.exported, sp.local);
        }
        break;
      }
      case 'ExportAll': {
        /* `export * from "m"`：不收。星号那种"导出哪些名字要看另一个文件"落不到这一层的
           模型上（整棵树拼成一个程序、名字共用一个顶层空间），所以照 `export … from …`
           同一句话报 —— 而且报在写它的那一行上。转口要一格一格写。 */
        diags.error(s.span, "'export * from …' is not supported; import the names and export them again");
        break;
      }
      case 'ExportDefault': {
        /* `export default <表达式>`（`export default function f(){}` 解析出来也是**表达式**）：
         * 摊成一句 `const <本模块专属的名字> = 表达式;`，导出表里记在 'default' 这一格。
         * 名字从模块路径来 —— 整棵树拼成一个程序，顶层名字共用一个空间，所以要带路径。 */
        const local = defaultLocal(m.path);
        m.exports.set('default', local);
        m.body.push({
          type: 'VarDecl',
          kind: 'const',
          decls: [{ id: { type: 'Ident', name: local, span: s.span }, init: s.value }],
          span: s.span,
        });
        break;
      }
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
    const m = { path, ast: parseJs(new SourceFile(path, text), diags), body: [], exports: new Map(), aliases: [], imports: [], natives: [], cnatives: [] };
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
  /* 改名摊出来的那一句绑定（`const 本地名 = 原名;`）也占**同一个**模块级作用域，所以它
   * 得跟真声明一样过一遍重名检查，而且同一个本地名只该摊一次。
   *
   * 从前每个导入方各摊一句：三个文件都写 `import { RELOC_ARM64 as RELOC }`，于是程序里有
   * 三句 `const RELOC = RELOC_ARM64`——同一个全局槽被反复赋值。更糟的是 `x64/asm.js` 自己
   * 导出了一格**不同**的 `RELOC`：那个槽先被 x64 的表填上，再被 arm64 的表盖掉，x64 的代码
   * 生成读到的就成了 arm64 的重定位号（量出来的静默错答案）。判据只有一条：本地名相同而
   * 来源不同就是撞名，当场报；来源相同则只留第一句。 */
  const aliasOf = new Map();
  const bindAlias = (local, from, span) => {
    const prev = aliasOf.get(local);
    if (prev !== undefined) {
      if (prev !== from) {
        diags.error(span, `'${local}' is bound to both '${prev}' and '${from}' at module scope; rename one`);
      }
      return false;
    }
    const own = owner.get(local);
    if (own !== undefined) {
      diags.error(span, `'${local}' is already declared at module scope in '${own}'; rename the alias`);
      return false;
    }
    aliasOf.set(local, from);
    return true;
  };
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
        /* 命名空间导入（`import * as ns from "m"`）：摊成一格**取值器对象** ——
         * `const ns = { get A() { return A; }, … };`。规范要的是**活绑定**，所以每一格都得是
         * getter（`ns.mut` 要看得见后来的改动）。这一格因此只在 JS 那条腿上成立：
         * 取值器要真对象，C 那边发射时会拒（ADR-0020 P1-c）。 */
        if (sp.kind === 'namespace') {
          if (!bindAlias(sp.local, `* from ${imp.path}`, imp.span)) continue;
          const props = [];
          for (const [exported, local] of target.exports) {
            props.push({
              kind: 'get',
              key: { type: 'Ident', name: exported, span: imp.span },
              computed: false,
              params: [],
              rest: null,
              body: {
                type: 'Block',
                body: [{ type: 'Return', arg: { type: 'Ident', name: local, span: imp.span }, span: imp.span }],
                span: imp.span,
              },
              span: imp.span,
            });
          }
          body.push({
            type: 'VarDecl',
            kind: 'const',
            decls: [{
              id: { type: 'Ident', name: sp.local, span: imp.span },
              init: { type: 'Object', props, span: imp.span },
            }],
            span: imp.span,
          });
          continue;
        }
        /* 默认导入（`import def from "m"`）：'default' 那一格记的是导出方那个专属名字，
         * 这儿摊成一句 `const def = <那个名字>;` —— 与命名的改名导入同一招。 */
        if (sp.kind === 'default') {
          const local = target.exports.get('default');
          if (local === undefined) {
            diags.error(imp.span, `'${imp.path}' has no default export`);
            continue;
          }
          if (!bindAlias(sp.local, local, imp.span)) continue;
          body.push({
            type: 'VarDecl',
            kind: 'const',
            decls: [{
              id: { type: 'Ident', name: sp.local, span: imp.span },
              init: { type: 'Ident', name: local, span: imp.span },
            }],
            span: imp.span,
          });
          continue;
        }
        if (sp.kind !== 'named') continue;
        if (!target.exports.has(sp.imported)) {
          diags.error(imp.span, `'${imp.path}' does not export '${sp.imported}'`);
          continue;
        }
        // 别名摊成一句模块级的绑定：不重命名，也就不需要作用域分析
        if (sp.local !== sp.imported && bindAlias(sp.local, sp.imported, imp.span)) {
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
    // 改名的导出：绑定排在模块体**之后**（本地那一格可能是 const，要先声明再引用）
    for (const al of m.aliases) {
      if (!bindAlias(al.to, al.from, al.span)) continue;
      body.push({
        type: 'VarDecl',
        kind: 'const',
        decls: [{
          id: { type: 'Ident', name: al.to, span: al.span },
          init: { type: 'Ident', name: al.from, span: al.span },
        }],
        span: al.span,
      });
    }
  }
  return { type: 'Program', body, natives, cnatives, modules: order.map((m) => m.path) };
}
