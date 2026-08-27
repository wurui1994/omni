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

import { stdout, stderr, stdinIsTty, readLine } from './host/native.js';
import { SourceFile, Diagnostics, OmniError } from './source/diag.js';
import { lex } from './parse/lexer.js';
import { emitJs } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';
import { loadProgram, newLoadState } from './module/load.js';
import { check, CheckSession } from './hir/check.js';
import { lowerCoreSession, CoreSession } from './sexpr/lower.js';
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
 * 核心 S 表达式方言那条腿：CoreSession。
 *
 * 语法驱动的前端（asy/jancy）印出来的就是这份方言，所以这一条**不是**为 .sx 文件加的功能，
 * 而是"新语言从语法来"这条路上 REPL 的落点：那门语言只要能把一批输入印成方言，
 * 增量、回滚、跨批可见性就都已经在这里了。
 */
class CoreLang {
  constructor() {
    this.name = 'sx';
    this.cs = new CoreSession();
  }

  // 方言里类型都写明了，没有"缺省注解怎么办"这回事，所以模式是固定的
  getMode() { return 'static'; }

  setMode(m) { throw new OmniError(`omni: ${this.name} has no type modes to switch`); }

  prelude() { return null; }

  /** 空动作：`;` 到行尾是注释，去掉之后什么都不剩就不编译 */
  blank(text) {
    return text.replace(/;[^\n]*/g, '').trim() === '';
  }

  complete(text) {
    let depth = 0;
    let str = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (str) {
        if (c === '\\') i++;
        else if (c === '"') str = false;
        continue;
      }
      if (c === '"') str = true;
      else if (c === ';') { while (i < text.length && text[i] !== '\n') i++; }
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    return depth <= 0 && !str;
  }

  // 方言里"打印一个值"就是 `(print E)`，写法本身已经是语句，没有回显这一层
  echo(text) { return null; }

  echoOptional(text) { return true; }

  asStmt(text) { return text; }

  snapshot() { return this.cs.snapshot(); }

  restore(s) { this.cs.restore(s); }

  add(text, diags) {
    const delta = this.cs.add(text, diags);
    diags.throwIfErrors();
    return delta;
  }

  full(chunks) {
    const diags = new Diagnostics();
    const mod = lowerCoreSession(`${chunks.join('\n')}\n`, diags);
    diags.throwIfErrors();
    return mod;
  }
}

/** `--lang` -> 语言模块。加一门语言就是加一行（前提是它能印出核心方言）。 */
function replLang(name, mode) {
  if (name === 'omni') return new OmniLang(mode);
  if (name === 'sx') return new CoreLang();
  throw new OmniError(`omni: repl: unknown language '${name}' (have: omni, sx)`);
}

/**
 * 会话驱动。与语言无关：它只知道"编译一批、装进运行期、跑这一批的入口"。
 */
class Session {
  constructor(langName, mode) {
    this.langName = langName;
    this.mode = mode;
    this.lang = null;
    this.rt = null;
    /** @type {string[]} 已接受的源码块，按输入顺序（只为 `:list` 与 `:js`/`:c` 而留） */
    this.chunks = [];
    this.boot();
  }

  /** 开一份干净的会话状态。`:reset` 就是再开一份 —— 没有"要清哪些表"的清单要维护。 */
  boot() {
    this.lang = replLang(this.langName, this.mode);
    this.rt = new InterpSession();
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
        stdout(cmd === ':js' ? emitJs(mod) : emitC(mod));
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
 */
export function startRepl(mode, lang = 'omni') {
  const s = new Session(lang, mode);
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
