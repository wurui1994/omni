// Omni stage0 — REPL（增量，前端无关）
//
// 两件事各占一层，别混：
//
//   1. **增量**。会话状态不再是"源码文本列表 + 每次重放"，而是三份常驻的东西：
//        - 模块图（module/load.js 的 newLoadState）：`std/json.omni` 只加载一次；
//        - 前端会话（hir/check.js 的 CheckSession 或 sexpr/lower.js 的 CoreSession）：
//          类型表、重载表、顶层作用域都留着，`defsDone`/`bodyDone` 保证旧函数体不重检；
//        - 运行期会话（interp/eval.js 的 InterpSession）：函数表、全局量、**顶层 Env**。
//      每批输入编译出来的是一份 delta（几个新函数 + 一个入口 `omni_chunk_N`），
//      装进运行期会话再跑那个入口。n 批输入的工作量是 O(n)，旧的重放是 O(n²)。
//      旧注释里"重放在当前语言下是语义精确的"仍然成立，但那条路要求整个会话可重跑 ——
//      一旦有文件 IO / 时钟 / 随机数就立刻塌，而且 n² 在几十行之后就已经能感觉到了。
//
//   2. **前端无关**。驱动（读行、续行、回显、命令、快照回滚）在这个文件里，与语言无关；
//      一门语言只要给出下面这套口子就有 REPL：
//        getMode/setMode、complete(text)、echo(text)、asStmt(text)、
//        snapshot()/restore(s)、add(text, diags) -> OIR delta、full(chunks) -> 整程序 OIR
//      Omni 走 CheckSession；核心 S 表达式方言走 CoreSession —— 后者才是关键：
//      语法驱动的前端（asy/jancy）印出来的就是这份方言，所以它们的 REPL 落在同一层上，
//      不用各写一遍增量与回滚。
//
// 编译失败 => 用 snapshot/restore 回到上一批成功的样子，这一块不进会话。
// 运行期失败 => 副作用已经发生（打出来的就打出来了），但这一块同样不收进会话。
//
// 默认模式是 `dynamic`（ADR-0008 第 3 节）：REPL 里 `x = 1` 之后 `x = "s"` 必须能过，
// 而混合模式下推断出来的变量是单态的。`--mode` 可覆盖。

import { stdout, stderr, stdinIsTty, readLine, evalJs, hasJsEngine } from './host/native.js';
import { SourceFile, Diagnostics, OmniError } from './source/diag.js';
import { lex } from './parse/lexer.js';
import { loadProgram, newLoadState } from './module/load.js';
import { check, CheckSession } from './hir/check.js';
/* 后端一律走注册表（ADR-0021 的 S4）：REPL 直接 import backend-js / backend-c 的话，
   **核心里就又有了一整套 JS 与 C 后端** —— 量出来那是核心 12.3 MB 里的一大块，而
   target-js / target-c 两格插件把同样的代码又发了一遍（target-c 那格 819 KB）。 */
import { cap, target } from './plugin.js';
import { parseJs } from './frontend-js/parser.js';
import { lowerJs, JsFrontSession } from './frontend-js/lower.js';
import { InterpSession } from './interp/eval.js';

const PROMPT = 'omni> ';
const CONT = '  ... ';

/** 这些开头一定是语句，不要试图当表达式回显 */
const STMT_HEAD = new Set([
  'if', 'else', 'while', 'for', 'return', 'break', 'continue', 'class', 'struct', 'void', 'let', 'var',
]);

// 名字带 REPL_ 前缀：链接之后所有模块级名字进同一个作用域，parse/parser.js 里
// 已经有一个 ASSIGN_OPS（那是 Omni 的赋值运算符表，这是 REPL 用来判断"像不像表达式"的）
const REPL_ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '++', '--']);

const OPEN = { '(': ')', '[': ']', '{': '}' };

/** 词法过不去就返回 null —— 调用方一律当成"完整输入"，让编译器去报错，
 *  否则一个未闭合的字符串会把用户永久卡在续行提示里。 */
function tokensOf(text) {
  const diags = new Diagnostics();
  const toks = lex(new SourceFile('<repl>', text), diags);
  if (diags.hasErrors()) return null;
  return toks.filter((t) => t.kind !== 'eof');
}

/** 括号没闭合就继续读下一行 */
function isComplete(text) {
  const toks = tokensOf(text);
  if (!toks) return true;
  const stack = [];
  for (const t of toks) {
    if (t.kind !== 'punct') continue;
    if (OPEN[t.value]) stack.push(OPEN[t.value]);
    else if (stack.length && t.value === stack[stack.length - 1]) stack.pop();
  }
  return stack.length === 0;
}

/**
 * 判断要不要把输入当表达式回显（`1 + 2` 打印 3）。
 * 三条排除规则，都能说清理由：
 *   - 以 `;` 或 `}` 收尾 => 用户显式写了语句，不回显（`f();` 不该试图打印 void）；
 *   - 以语句关键字开头 => 是语句；
 *   - 顶层有赋值/自增运算符 => 是语句（`x = 5`、`i++` 不回显，和 Python 一致）。
 */
function looksLikeExpr(text) {
  const t = text.trim();
  if (!t || /[;}]$/.test(t)) return false;
  const toks = tokensOf(t);
  if (!toks || toks.length === 0) return false;
  if (toks[0].kind === 'kw' && STMT_HEAD.has(toks[0].value)) return false;
  let depth = 0;
  for (const tok of toks) {
    if (tok.kind !== 'punct') continue;
    if (OPEN[tok.value]) depth++;
    else if (tok.value === ')' || tok.value === ']' || tok.value === '}') depth--;
    else if (depth === 0 && REPL_ASSIGN_OPS.has(tok.value)) return false;
  }
  return true;
}

/**
 * REPL 的隐式前言。
 *
 * 交互式会话里回显的值随时可能是 dynamic（json 字面量、parseJson 的结果、动态模式下的一切），
 * 而 `print(dynamic)` 要降级成 std/json 的 dynToText —— 每开一个会话先手打一行 import 没有意义。
 * 这是**唯一**一处隐式导入，而且只在 REPL 里：源文件不享受这个待遇，文件的依赖必须写在文件里
 * （ADR-0009）。它是**第 0 批**（自成一块），所以用户那一块的诊断行号就是它自己的行号，
 * 不需要"减掉前缀行数"那种事后修正。`:list` 刻意不显示它，它不是用户输入的一部分。
 */
const PRELUDE = 'import "std/json.omni";';

/** Omni 那条腿：模块图 + CheckSession。 */
class OmniLang {
  constructor(mode) {
    this.name = 'omni';
    this.state = newLoadState();
    this.ck = new CheckSession(mode);
  }

  getMode() { return this.ck.getMode(); }

  setMode(m) { this.ck.setMode(m); }

  prelude() { return PRELUDE; }

  /** 空动作：Omni 的注释是词法层的事，交给词法器数 token */
  blank(text) {
    const toks = tokensOf(text);
    return toks !== null && toks.length === 0;
  }

  complete(text) { return isComplete(text); }

  /** 表达式回显：包成 `print(E);`。不像表达式就返回 null，由调用方当语句处理。 */
  echo(text) { return looksLikeExpr(text) ? `print(${text});` : null; }

  /** 回显失败后的退路：以 `)` 收尾的可能本来就是"要副作用不要值" */
  echoOptional(text) { return text.trim().endsWith(')'); }

  asStmt(text) { return /[;}]$/.test(text.trim()) ? text : `${text};`; }

  snapshot() {
    const done = new Map();
    for (const kv of this.state.done) done.set(kv[0], kv[1]);
    const imports = new Map();
    for (const kv of this.state.imports) imports.set(kv[0], new Set(kv[1]));
    return { ck: this.ck.snapshot(), done: done, imports: imports, nextId: this.state.nextId };
  }

  restore(s) {
    this.ck.restore(s.ck);
    this.state.done = s.done;
    this.state.imports = s.imports;
    this.state.nextId = s.nextId;
  }

  /** 一批 -> 这一批新增的 OIR。诊断有错就抛（驱动负责回滚）。 */
  add(text, diags) {
    const r = loadProgram({
      path: '<repl>', text: `${text}\n`, mode: this.getMode(), diags: diags, state: this.state,
    });
    diags.throwIfErrors();
    const delta = this.ck.add({ kind: 'Program', decls: r.decls, imports: r.imports }, diags);
    diags.throwIfErrors();
    return delta;
  }

  /** `:js` / `:c` 要的是"整个会话作为一个程序"，跟增量状态无关，所以另开一份干净的编译 */
  full(chunks) {
    const diags = new Diagnostics();
    const text = `${[PRELUDE, ...chunks].join('\n')}\n`;
    const r = loadProgram({ path: '<repl>', text: text, mode: this.getMode(), diags: diags });
    diags.throwIfErrors();
    const mod = check({ kind: 'Program', decls: r.decls, imports: r.imports }, diags, this.getMode());
    diags.throwIfErrors();
    return mod;
  }
}

/**
 * 核心 S 表达式方言那条腿（CoreSession）与 asy 那条腿都搬去了 lang/{sx,asy}.js
 * （ADR-0021 的 S4）：一门语言的 REPL 会话是那门语言自带的东西，驱动只按名字要
 * 一格（`cap('sx.repl')` / `cap('asy.repl')`）。于是 `--builtins min` 的核心里
 * sexpr/lower.js 与 frontend-asy/* 都不必进来。
 */





/** 括号平衡（字符串与注释里的不算）。JS 那条腿的续行判断用它（asy 那条在 lang/asy.js
 *  自己有一份同形的 —— 插件不许伸手拿驱动的东西）。 */
function asyBalanced(text) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    i++;
  }
  return depth <= 0;
}

/** `--lang` -> 语言模块。加一门语言就是加一行（前提是它能印出核心方言）。
 *  sx / asy 那两条的整套会话在 lang/{sx,asy}.js 里（ADR-0021 S4）：REPL 也是一门语言
 *  自带的东西，驱动只按名字要一格 —— 于是薄核心里 frontend-asy 与 sexpr 都不必进来。 */
function replLang(name, mode, deps) {
  if (name === 'omni') return new OmniLang(mode);
  if (name === 'sx') return cap('sx.repl')();
  if (name === 'asy') return cap('asy.repl')(deps);
  if (name === 'js') return new JsLang();
  throw new OmniError(`omni: repl: unknown language '${name}' (have: omni, sx, asy, js)`);
}

/** JS 那条腿的"像不像表达式"。判据与 Omni 那条同一套，只是关键字表是 JS 的。 */
function jsLooksLikeExpr(text) {
  const t = text.trim();
  if (!t || /[;}]$/.test(t)) return false;
  if (/^(const|let|var|function|class|if|else|while|for|do|return|throw|try|switch|break|continue|import|export|new)\b/.test(t)) return false;
  const bare = t.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  if (/(\+\+|--)/.test(bare)) return false;
  let depth = 0;
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '=' && bare[i + 1] !== '=' && '=!<>+-*/%'.indexOf(bare[i - 1] ?? ' ') < 0) return false;
  }
  return true;
}

/**
 * JS 那条腿：frontend-js 的增量会话（`--lang js`）。
 *
 * 这一条不需要宿主有"能吃 JS 文本"的引擎 —— 它是**前端**：一批 JS 输入降成 OIR delta，
 * 谁来执行是引擎那一格的事（解释器在任何宿主上都成立）。所以原生二进制上一样有
 * 交互式的 JS：`omni repl --lang js`。
 *
 * 跨批可见性靠的是"JS 的顶层 let/const/var 本来就降成模块级全局"（ADR-0011），
 * 不是常驻的顶层 Env —— 见 frontend-js/lower.js 的 JsFrontSession 头注。
 * import/export 在这条腿上还不支持（collectTop 会报），所以会话里只有封闭 ABI 的全局。
 */
class JsLang {
  constructor() {
    this.name = 'js';
    this.fs = new JsFrontSession();
  }

  // JS 的值域全是 dynamic，没有"缺省注解怎么办"这回事
  getMode() { return 'dynamic'; }

  setMode(m) { throw new OmniError(`omni: ${this.name} has no type modes to switch`); }

  prelude() { return null; }

  blank(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim() === '';
  }

  // 括号平衡：JS 的注释与字符串规则和 asy 那份一样（模板字面量里的括号算多了也只是多读一行）
  complete(text) { return asyBalanced(text); }

  echo(text) { return jsLooksLikeExpr(text) ? `console.log(${text});` : null; }

  echoOptional(text) { return text.trim().endsWith(')'); }

  asStmt(text) { return /[;}]$/.test(text.trim()) ? text : `${text};`; }

  snapshot() { return this.fs.snapshot(); }

  restore(s) { this.fs.restore(s); }

  add(text, diags) {
    const prog = parseJs(new SourceFile('<repl>', `${text}\n`), diags);
    diags.throwIfErrors();
    const delta = this.fs.add(prog, diags);
    diags.throwIfErrors();
    return delta;
  }

  full(chunks) {
    const diags = new Diagnostics();
    const prog = parseJs(new SourceFile('<repl>', `${chunks.join('\n')}\n`), diags);
    diags.throwIfErrors();
    const mod = lowerJs(prog, diags);
    diags.throwIfErrors();
    return mod;
  }
}

/**
 * 执行引擎之二：**JS 后端**（`--engine js`）。
 *
 * 与解释器那一份的差别只在"一批怎么跑"，装进会话的接口是同一个（install / runEntry），
 * 所以驱动、回滚、跨批可见性一行都不用改。增量在这一层是这样成立的：
 *   - 运行时那一份（prelude + 两张派发表）**只装一次**，它自己把顶层名字挂到 globalThis；
 *   - 每批只发这一批的片段（`emitJs(..., {repl: true})`），装进**同一个全局作用域** ——
 *     于是第 1 批的函数与模块级变量第 2 批照样看得见，旧批次一个字节都不重发。
 * 每批发出去的字节数因此是常数（tests/repl/incremental.js 钉的就是这个数）。
 *
 * 这一格要的是**第三方 JS 引擎**（node 的 eval），不是"JS 能力" —— 原生构建里 JS 源码
 * 照样能编能跑（前端 + 别的后端，tests/js-exec 那条轴在自举出来的编译器上也过），
 * 缺的只是"把一段 JS 文本当程序直接跑"的那一步。所以 newEngine 在没有引擎的宿主上
 * 报的是这句话，而不是"这边没有 JS"。把它补上的路子是让**后端的产物落回前端**
 * （generated JS 走 frontend-js -> OIR -> 解释器），那要先把产物用到的 JS 收进子集
 * （已经补了带标签的 break/continue；还差 Object.is、`>>>`、process.exit、2^64 字面量，
 * 以及一张"prelude 的 $ 辅助名字 -> 运行时原语"的表）。
 */
export class JsSession {
  constructor() {
    evalJs(cap('jsgen.runtimeModule')());
    // 运行期错误默认是"打一行、退 70"，在 REPL 里那等于杀掉会话。装个钩子改成 throw；
    // 消息先落在一个全局槽里，于是**跨回这一侧的只有字符串**（宿主的异常对象在这个
    // 值域里不是 dict，漏进来就是一句莫名的 "function is not an object"）。
    evalJs('$js_set_error_hook(function (m) {'
      + ' globalThis.$OMNI_REPL_ERR = "rt:" + m; throw new Error("omni-repl-abort"); });');
    this.lastBytes = 0;
  }

  install(mod) {
    const src = target('js').emit(mod, { repl: true });
    this.lastBytes = src.length;
    evalJs(src);
  }

  runEntry(name) {
    // try/catch 与"取待决错误"都写在被 eval 的那段里，理由同上：边界上只过字符串。
    // **整段都在 try 里**：取待决错误那几句自己也会碰上运行期错误（比如错误对象不是
    // 字符串），钩子一 throw 就会从 eval 里飞出来把整个会话带走 —— 曾经就是。
    // 文本化用 prelude 自己的 $js_err_text，和整程序那条路（js_check_uncaught）
    // 以及解释器那条腿（builtin.js 的 jsErrText）说同一句话。
    const st = evalJs(`(function () {
      globalThis.$OMNI_REPL_ERR = "";
      try {
        ${name}();
        $flush();
        if ($js_pending()) {
          globalThis.$OMNI_REPL_ERR = "uncaught:" + $js_err_text($js_take_pending());
        }
      } catch (e) {
        if (globalThis.$OMNI_REPL_ERR === "") throw e;
      }
      $flush();
      return globalThis.$OMNI_REPL_ERR;
    })()`);
    if (st === '') return { failed: false, err: '' };
    if (st.startsWith('rt:')) return { failed: true, err: `omni: runtime error: ${st.slice(3)}\n` };
    return { failed: true, err: `omni: uncaught: ${st.slice(9)}\n` };
  }
}

/** 引擎名 -> 一份常驻运行期。表在这里，加一条就多一个方向。 */
function newEngine(name) {
  if (name === 'interp') return new InterpSession();
  if (name === 'js') {
    // 能力先问再用（宿主的错误不是可以 catch 的异常）。这句话要说清缺的是**哪一格**：
    // 不是"这边没有 JS"，而是"这边没有能直接吃 JS 文本的引擎"。
    if (!hasJsEngine()) {
      throw new OmniError('omni: repl --engine js needs a host that can evaluate JS text '
        + "(the node host can; this build cannot). JS *sources* still compile and run here "
        + "— try 'omni run x.js' — and the repl's other engines are unaffected.");
    }
    return new JsSession();
  }
  throw new OmniError(`unknown repl engine '${name}' (interp | js)`);
}

/**
 * 会话驱动。与语言无关：它只知道"编译一批、装进运行期、跑这一批的入口"。
 */
class Session {
  constructor(langName, mode, deps, engine) {
    this.langName = langName;
    this.mode = mode;
    this.deps = deps;
    this.engine = engine === undefined ? 'interp' : engine;
    this.lang = null;
    this.rt = null;
    /** @type {string[]} 已接受的源码块，按输入顺序（只为 `:list` 与 `:js`/`:c` 而留） */
    this.chunks = [];
    this.boot();
  }

  /** 开一份干净的会话状态。`:reset` 就是再开一份 —— 没有"要清哪些表"的清单要维护。 */
  boot() {
    this.lang = replLang(this.langName, this.mode, this.deps);
    this.rt = newEngine(this.engine);
    this.chunks = [];
    const pre = this.lang.prelude();
    // 隐式前言自成第 0 批：跑它是为了让被导入模块的顶层初始化真的发生
    if (pre !== null) this.attempt(pre);
  }

  reset() {
    // 模式是用户设过的，reset 不该把它一起忘掉
    this.mode = this.lang.getMode();
    this.boot();
  }

  /**
   * 编译并执行一批。失败就回到上一批成功的样子。
   * @returns {{ok: boolean, err: string}}
   */
  attempt(text) {
    const snap = this.lang.snapshot();
    const diags = new Diagnostics();
    let delta = null;
    try {
      delta = this.lang.add(text, diags);
    } catch (e) {
      if (!(e instanceof OmniError)) throw e;
      this.lang.restore(snap);
      return { ok: false, err: `${e.message}\n` };
    }
    if (delta === null) {
      this.lang.restore(snap);
      return { ok: false, err: 'omni: repl: front end produced nothing\n' };
    }
    this.rt.install(delta);
    const r = this.rt.runEntry(delta.entry);
    if (r.failed) {
      // 副作用已经发生（打出来的就打出来了），但这一块不收进会话：
      // 它的声明回滚掉，下一批看不见它 —— 和编译失败一样的语义。
      this.lang.restore(snap);
      return { ok: false, err: r.err };
    }
    return { ok: true, err: '' };
  }

  /** 处理一次输入。返回 false 表示这块没被接受。 */
  feed(text) {
    const t = text.trim();
    // 只有注释（或什么都没有）就是个空动作：不编译，也不进会话
    if (this.lang.blank(t)) return true;
    const echo = this.lang.echo(t);
    if (echo !== null) {
      const r = this.attempt(echo);
      if (r.ok) {
        this.chunks.push(echo);
        return true;
      }
      // 回显没成。以 `)` 收尾的（函数/方法调用）可能本来就是"要副作用不要值"，
      // 悄悄退回语句；其余情况必须报错，否则一个不支持的回显会静默什么都不做。
      if (!this.lang.echoOptional(t)) {
        stderr(r.err);
        return false;
      }
    }
    const src = this.lang.asStmt(t);
    const r = this.attempt(src);
    if (!r.ok) {
      stderr(r.err);
      return false;
    }
    this.chunks.push(src);
    return true;
  }
}

const HELP = `commands:
  :help          this list
  :quit          leave (Ctrl-D also works)
  :list          the session source accepted so far
  :reset         forget the whole session
  :mode [M]      show, or switch to, mixed | dynamic | static
  :js            print the JS generated for the session
  :c             print the C generated for the session

notes:
  an expression on its own line is echoed:  1 + 2  =>  3
  trailing ';' means "statement", so nothing is echoed
  a line whose brackets are unbalanced continues on the next line
`;

/** @returns {boolean} true 表示要退出 */
function command(s, line) {
  const parts = line.trim().split(/\s+/, 2);
  const cmd = parts[0];
  const arg = parts[1];
  switch (cmd) {
    case ':help':
    case ':h':
      stdout(HELP);
      return false;
    case ':quit':
    case ':q':
      return true;
    case ':list':
      // 只列用户输入过的块；隐式前言不是会话内容（见 PRELUDE）
      stdout(s.chunks.length ? `${s.chunks.join('\n')}\n` : '(empty session)\n');
      return false;
    case ':reset':
      s.reset();
      stdout('session reset\n');
      return false;
    case ':mode':
      if (!arg) stdout(`${s.lang.getMode()}\n`);
      else if (['mixed', 'dynamic', 'static'].includes(arg)) {
        try {
          s.lang.setMode(arg);
          stdout(`mode = ${arg}\n`);
        } catch (e) {
          if (!(e instanceof OmniError)) throw e;
          stderr(`${e.message}\n`);
        }
      } else stderr(`omni: mode must be one of mixed, dynamic, static (got '${arg}')\n`);
      return false;
    case ':js':
    case ':c':
      try {
        const mod = s.lang.full(s.chunks);
        stdout(cmd === ':js' ? target('js').emit(mod) : target('c').emit(mod));
      } catch (e) {
        if (!(e instanceof OmniError)) throw e;
        stderr(`${e.message}\n`);
      }
      return false;
    default:
      stderr(`omni: unknown command '${cmd}' (try :help)\n`);
      return false;
  }
}

/**
 * @param {string} mode 缺省类型注解的处理方式（ADR-0008）
 * @param {string} [lang] 语言（`--lang`）；默认 omni
 * @param {any} [deps] 需要文件 IO / 语法表的那些零件，由 cli.js 注入（asy 用）
 * @param {string} [engine] 执行引擎（`--engine`）：interp | js；默认 interp
 */
export function startRepl(mode, lang = 'omni', deps = undefined, engine = 'interp') {
  const s = new Session(lang, mode, deps, engine);
  const tty = stdinIsTty();
  let buf = '';

  // 提示符只在交互式终端里写，管道输入时保持 stdout 干净（测试要逐字节比对）
  const prompt = () => { if (tty) stdout(buf ? CONT : PROMPT); };

  if (tty) stdout(`omni stage0 repl — ${lang}, mode ${s.lang.getMode()}, :help for commands\n`);
  prompt();

  // 阻塞地一行一行读（宿主的 readLine，决策 17）。不用 node 的 readline 事件：
  // 那是宿主独有的东西，而这个文件自己也要被降级；REPL 本来就是"等人打字"的地方。
  for (;;) {
    const line = readLine();
    if (line === undefined) break;  // EOF（Ctrl-D 或管道读完）
    if (!buf && line.trim().startsWith(':')) {
      if (command(s, line)) return 0;
      prompt();
      continue;
    }
    // 续行中遇到空行就强制提交（否则括号打错的人出不来），和 python 的 REPL 一样
    if (buf && line.trim() === '') {
      const text = buf;
      buf = '';
      if (text.trim()) s.feed(text);
      prompt();
      continue;
    }
    buf = buf ? `${buf}\n${line}` : line;
    if (!buf.trim()) { buf = ''; prompt(); continue; }
    if (!s.lang.complete(buf)) { prompt(); continue; }
    const text = buf;
    buf = '';
    s.feed(text);
    prompt();
  }

  // 管道输入结束时可能还有没闭合的残料，交给编译器报错而不是静静丢掉
  if (buf.trim()) s.feed(buf);
  if (tty) stdout('\n');
  return 0;
}
