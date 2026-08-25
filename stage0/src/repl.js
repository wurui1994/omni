// Omni stage0 — REPL
//
// 策略：**重放整个会话**，而不是真正的增量编译。
// ADR-0008 第 3 节写的是"每次输入是一个增量编译单元"，那是目标状态；stage0 的检查器是
// 整程序的（所有 decl 并成一个 program），没有模块系统之前做不到只编译新增顶层项。
//
// 重放在**当前**语言下是语义精确的，不是偷懒：stage0 的可观察副作用只有 `print`，
// 没有文件 IO、没有时钟、没有随机数，所以"从头跑一遍"和"接着上次跑"结果必然相同。
// 于是每次输入：
//   1. 把新块接到已接受的块后面，整体编译；
//   2. 整体执行，捕获 stdout，只把**比上次多出来的那一段**打给用户；
//   3. 编译或运行失败 => 这一块不进会话，状态自动回到上一次成功的样子（无需回滚代码）。
// 代价是 O(n²)：会话有 n 块就编译 n 次。stage0 编译一个几十行的程序是十几毫秒，够用。
// 真·增量编译等模块系统落地（PLAN.md 下一步第 2 项）。
//
// 默认模式是 `dynamic`（ADR-0008 第 3 节）：REPL 里 `x = 1` 之后 `x = "s"` 必须能过，
// 而混合模式下推断出来的变量是单态的。`--mode` 可覆盖。
//
// 这个默认值曾经被临时改成 mixed，因为那时 `dynamic` 上没有算术，`x = 10` 之后 `x * x`
// 会报错，一个连乘法都做不了的 REPL 没有意义。`dynamic` 的算术与 `print(容器)` 落地后
// （2026-08-26）已改回 ADR 写的 dynamic：同一份 tests/repl/session.in 在两个模式下
// 除 `:mode` 那行外输出逐字节相同，而 dynamic 额外拿到了重新赋不同类型的能力。

import { stdout, stderr, stdinIsTty, readLine, evalCaptured } from './host/native.js';
import { SourceFile, Diagnostics, OmniError } from './source/diag.js';
import { lex } from './parse/lexer.js';
import { emitJs } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';

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

/** 在进程内执行生成的 JS，把 stdout/stderr 收进字符串。
 *  截住 stdout / stderr / exit 这件事本身是宿主能力（决策 17 的 evalCaptured）：
 *  生成的 JS 里 `$rt_error` 走 process.exit(70)，REPL 不能真的退出。 */
function runCaptured(code) {
  const r = evalCaptured(code);
  return { out: r[0], err: r[1], failed: r[2] };
}

/** 诊断里的行号是**整个会话**的，对 REPL 没意义；减掉前缀行数，让它指向本次输入 */
function renumber(text, base) {
  return text.replace(/^<repl>:(\d+):/gm, (m, l) => `<repl>:${Number(l) - base}:`);
}

/**
 * REPL 的隐式前言。
 *
 * 交互式会话里回显的值随时可能是 dynamic（json 字面量、parseJson 的结果、动态模式下的一切），
 * 而 `print(dynamic)` 要降级成 std/json 的 dynToText —— 每开一个会话先手打一行 import 没有意义。
 * 这是**唯一**一处隐式导入，而且只在 REPL 里：源文件不享受这个待遇，文件的依赖必须写在文件里
 * （ADR-0009）。`:list` 刻意不显示它，它不是用户输入的一部分。
 */
const PRELUDE = 'import "std/json.omni";';

class Session {
  /** @param {(path: string, text: string, mode: string) => any} compileText */
  constructor(compileText, mode) {
    this.compileText = compileText;
    this.mode = mode;
    /** @type {string[]} 已接受的源码块，按输入顺序 */
    this.chunks = [];
    /** 上一次成功重放产生的全部 stdout；用来算增量 */
    this.lastOut = '';
  }

  source(extra) {
    const parts = extra === undefined ? this.chunks : [...this.chunks, extra];
    return `${[PRELUDE, ...parts].join('\n')}\n`;
  }

  /** 前缀（前言 + 已接受的块）占了多少行 —— 诊断行号要减掉它 */
  priorLines() {
    return this.source().split('\n').length - 1;
  }

  compile(extra) {
    return this.compileText('<repl>', this.source(extra), this.mode);
  }

  /** 编译并执行一个候选块，不改会话状态 */
  attempt(chunk) {
    let mod;
    try {
      mod = this.compile(chunk).mod;
    } catch (e) {
      if (!(e instanceof OmniError)) throw e;
      return { compiled: false, err: e };
    }
    return { compiled: true, chunk, ...runCaptured(emitJs(mod)) };
  }

  /** 把执行结果呈现出来；跑通了就把这块收进会话 */
  commit(r) {
    // 重放是确定性的，所以新输出必然以上次输出为前缀；万一不是，就整段打出来
    const delta = r.out.startsWith(this.lastOut) ? r.out.slice(this.lastOut.length) : r.out;
    if (delta) stdout(delta);
    if (r.err) stderr(r.err);
    if (r.failed) return false;  // 运行期错误：不收这一块，会话回到上次成功的状态
    this.chunks.push(r.chunk);
    this.lastOut = r.out;
    return true;
  }

  /** 处理一次输入。返回 false 表示这块没被接受。 */
  feed(text) {
    const t = text.trim();
    const base = this.priorLines();
    const fail = (e) => {
      stderr(`${renumber(e.message, base)}\n`);
      return false;
    };

    if (looksLikeExpr(t)) {
      const echo = this.attempt(`print(${t});`);
      if (echo.compiled) return this.commit(echo);
      // 回显编译不过。以 `)` 收尾的（函数/方法调用）可能本来就是"要副作用不要值"，
      // 悄悄退回语句；其余情况必须报错，否则 `ys`（print 还不支持 list）会静默什么都不做。
      if (!t.endsWith(')')) return fail(echo.err);
    }

    const r = this.attempt(/[;}]$/.test(t) ? t : `${t};`);
    return r.compiled ? this.commit(r) : fail(r.err);
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
  const [cmd, arg] = line.trim().split(/\s+/, 2);
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
      s.chunks = [];
      s.lastOut = '';
      stdout('session reset\n');
      return false;
    case ':mode':
      if (!arg) stdout(`${s.mode}\n`);
      else if (['mixed', 'dynamic', 'static'].includes(arg)) {
        s.mode = arg;
        stdout(`mode = ${arg}\n`);
      } else stderr(`omni: mode must be one of mixed, dynamic, static (got '${arg}')\n`);
      return false;
    case ':js':
    case ':c':
      try {
        const { mod } = s.compile();
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
 * @param {(path: string, text: string, mode: string) => any} compileText 由 cli.js 注入，
 *   避免 repl.js 反过来 import cli.js（cli.js 顶层就跑 main，成环会很难看）
 * @param {string} mode
 */
export function startRepl(compileText, mode) {
  const s = new Session(compileText, mode);
  const tty = stdinIsTty();
  let buf = '';

  // 提示符只在交互式终端里写，管道输入时保持 stdout 干净（测试要逐字节比对）
  const prompt = () => { if (tty) stdout(buf ? CONT : PROMPT); };

  if (tty) stdout(`omni stage0 repl — mode ${mode}, :help for commands\n`);
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
    if (!isComplete(buf)) { prompt(); continue; }
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
