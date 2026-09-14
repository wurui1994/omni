// src/lang/jnc/stmt-table.js —— **语句分派表**（jnc 的语句一格一格落成方言的哪几行）
//
// 这是从旧降级 `stmt0`（`frontend-jnc/lower.js:10294-10530`）整块读出来的那张表。表里一格
// 对一个节点头，值是"这一格怎么落"：`text` 是就地能拼出来的模板，`kind` 说它属于哪一族
// （不发码 / 一行 / 带体 / 还不收）。驱动照表走，**不再按记忆猜**。
//
// 表里不含表达式那一半：表达式由调用方给的 `expr(node)` 回来一段文字（那是另一张表）。
// 体由 `block(node, ind)` 回来一段文字。两个回调都由驱动注入 —— 这一层只管"语句的形状"。
//
// 出处（行号都在 lower.js）：
//   10298 empty-stmt / 10299 type-decl / 10300 compound / 10309 alias / 10315 var-decl
//   10316 var-decl-curly / 10317 expr-stmt / 10318..10322 if/while/do/for/switch
//   10327 return / 10341 typedef / 10361 attributed / 10387 throw / 10403 break/continue
//   10447 assert / 10448 unsafe / 10462 try / 10481 catch/finally / 10497 nestedscope
//   10515 once / 10349 dylayout

/** 不发一个字的那几族（声明与元数据）。 */
export const NO_CODE = new Set(['empty-stmt', 'type-decl', 'typedef']);

/** 还不收的那几族（都是"要一整套机器"的，各带出处）。 */
export const NOT_YET = new Map([
  ['dylayout', '`dylayout (layout) { … }` —— 动态布局那一整套（读 jnc.DynamicLayout 上那格 validator）'],
  ['finally', '`finally:` —— 不管走哪条路都要跑一遍（jancy 为它开了 finallyRouteIdx，jnc_ct_ControlFlowMgr_Eh.cpp:41-50）'],
  ['nestedscope', '`nestedscope:` —— 把后面那一段变成一格嵌套的可弃作用域（disposable.rst:17）'],
  ['regex-switch', '属性块里的 `Regex…` 不是元数据，是 regex switch 那台 DFA 的开关（Stmt.llk:207）'],
]);

/**
 * **一格语句怎么落**。`ctx` 要给：
 *   { pad, ind, expr(node), block(node, ind), stmt(node, ind), levels, once(), escape() }
 * 答一串行；这一格表里没有就答 `null`（驱动照旧走老路 / 记账）。
 */
export function stmtLines(head, n, ctx) {
  const { pad } = ctx;
  if (NO_CODE.has(head)) return [];
  if (head === 'compound') {
    const b = ctx.block(n, ctx.ind + 2);
    return b === null ? null : [`${pad}(do`, b, `${pad})`];
  }
  if (head === 'attributed') return ctx.stmt(ctx.hole(n, 'decl') ?? ctx.hole(n, 'stat'), ctx.ind);
  if (head === 'unsafe') {
    const b = ctx.block(ctx.hole(n, 'body'), ctx.ind + 2);
    return b === null ? null : [`${pad}(unsafe`, b, `${pad})`];
  }
  /* **`try { … }`** 不是"把错忽略掉"：出错时那一块剩下的语句一句都不跑，然后从块后面接着走
     （exceptions.rst:53-57）。方言里"跳到一格作用域的出口"就是那圈**一次性循环**的 `brk`
     —— 与带步进的 `for` 套的那一圈是同一个东西，所以方言不用长新形式。 */
  if (head === 'try') {
    const b = ctx.block(ctx.hole(n, 'body'), ctx.ind + 4);
    return b === null ? null : [
      `${pad}(while (bool true)`,
      `${pad}  (do`,
      b,
      `${pad}    (brk)`,
      `${pad}  )`,
      `${pad})`,
    ];
  }
  /* **`once <语句>`**：与 `static` 局部量（第二十六刀）用的是同一道闸门 —— jancy 那边
     `once` 包着 `initializeVariable`（jnc_ct_Parser.cpp:2452）。"线程安全"那句在这一层是
     白拿的（方言没有线程），不是少做了一件事。`threadlocal once` 照旧不收。 */
  if (head === 'once') {
    const flag = ctx.once();
    const body = ctx.stmt(ctx.hole(n, 'body'), ctx.ind + 4);
    if (body === null) return null;
    return [
      `${pad}(if (un "!" (var ${flag}))`,
      `${pad}  (do`,
      `${pad}    (set ${flag} (bool true))`,
      ...body,
      `${pad}  )`,
      `${pad})`,
    ];
  }
  /* **`throw;`** 与"errorcode 调用出错时那一跳"落的是同一段代码（第五十九刀的 `escape`）：
     有 guard 就跳那圈一次性循环的 `brk`、没有就 `(ret 当前的错)`。 */
  if (head === 'throw') return [`${pad}${ctx.escape()}`];
  return null;
}

/**
 * **`break N` / `continue N` 的层号**（旧降级 lower.js:10403-10445 那一段）。
 * `loops` 是循环栈，每格 `{ kind: 'loop' | 'switch' | 'oneshot', step }`：
 *   - `break` 往外数时 **switch 也算一层**（cflow_switch.rst:37 的 `break2` 就是"出 switch
 *     再出循环"），而我们自己摊出来的一次性循环（`oneshot`）**不算**；
 *   - `continue` **只数真循环**（switch 与一次性都不算，与 C 同）——所以 switch 里的
 *     `continue` 落成 `(cont 2)`：跳过合成的那圈，回到外面那个真循环；
 *   - 带步进的 `for`：`continue` 跳的是它体外那圈**一次性**循环的 `brk` —— 落点正好在步进之前
 *     （第四十二刀）。
 * 层号是"到栈顶的距离"，所以一次性那几圈自然被数进去。数不着答 `{ level: null, seen }`。
 */
export function jumpLevel(kind, lvl, loops) {
  if (kind === 'break') {
    let seen = 0;
    for (let i = loops.length - 1; i >= 0; i -= 1) {
      if (loops[i].kind === 'oneshot') continue;
      seen += 1;
      if (seen === lvl) return { op: 'brk', level: loops.length - i, seen };
    }
    return { op: 'brk', level: null, seen };
  }
  let seen = 0;
  for (let i = loops.length - 1; i >= 0; i -= 1) {
    if (loops[i].kind !== 'loop') continue;
    seen += 1;
    if (seen !== lvl) continue;
    /* 带步进的那一格：跳体外那圈一次性循环的 `brk`。 */
    if (loops[i + 1] !== undefined && loops[i + 1].kind === 'oneshot') {
      return { op: 'brk', level: loops.length - (i + 1), seen };
    }
    if (loops[i].step === true) return { op: 'cont', level: null, seen, bug: true };
    return { op: 'cont', level: loops.length - i, seen };
  }
  return { op: 'cont', level: null, seen };
}

/** 层号发成方言的一行（`(brk)` / `(brk 2)` / `(cont)` / `(cont 3)`）。 */
export function jumpText(op, level) {
  return `(${op}${level === 1 ? '' : ` ${level}`})`;
}

/* ─── 三种循环的模板（lower.js:12888-12997）───────────────────────────────────
   这三格是"方言里没有的形状怎么用有的形状拼出来"，每格的坑都写在注里。 */

/** `while (C) BODY` —— 方言直接有这一格。 */
export function whileLines(condText, body, pad) {
  return [`${pad}(while ${condText}`, body, `${pad})`];
}

/**
 * `do BODY while (C);` —— 方言里**没有**后置判断的循环，所以借一格标志：
 *
 *   (let $doN bool (bool true))
 *   (while (bin "||" (var $doN) C)
 *     (do (set $doN (bool false)) BODY))
 *
 * `||` **短路**，所以第一圈不算 C（要紧：C 里可能有第一圈还没成立的东西）；第二圈起判断
 * 落在循环头，也就是第一圈的体之后 —— 与 do-while 的语义一致。
 *
 * 标志清零放在体的**开头**而不是末尾：放末尾时体里的 `continue` 会把它跳过去，于是变成
 * 死循环。放开头就没有这个坑（`break` 照旧从 `while` 里出去）。
 */
export function doWhileLines(flag, condText, body, pad) {
  return [
    `${pad}(let ${flag} bool (bool true))`,
    `${pad}(while (bin "||" (var ${flag}) ${condText})`,
    `${pad}  (do`,
    `${pad}    (set ${flag} (bool false))`,
    body,
    `${pad}  )`,
    `${pad})`,
  ];
}

/**
 * `for (INIT; C; STEP) BODY` → `(do INIT (while C (do BODY STEP)))`。
 *
 * 三格都可以空：没有 C 时是 `(bool true)`。INIT 里的声明要能被 C / STEP / BODY 看见，
 * 所以整条包在一个 `(do …)` 里 —— 那个 do 自带一层作用域。
 *
 * **带步进又有 `continue` 指着这一层时给体套一圈一次性循环**（第四十二刀）：`continue`
 * 变成那圈的 `(brk)`，落点正好在步进之前。不套的话方言的 `cont` 跳到循环头，会漏掉一次步进。
 */
export function forLines({
  initLines, condText, stepLines, body, oneshot, pad,
}) {
  const out = [`${pad}(do`, ...initLines];
  out.push(`${pad}  (while ${condText === null ? '(bool true)' : condText}`);
  out.push(`${pad}    (do`);
  if (oneshot === true) {
    out.push(`${pad}      (while (bool true)`);
    out.push(`${pad}        (do`);
    out.push(body);
    out.push(`${pad}          (brk)`);
    out.push(`${pad}        )`);
    out.push(`${pad}      )`);
  } else {
    out.push(body);
  }
  out.push(...stepLines);
  out.push(`${pad}    )`);
  out.push(`${pad}  )`);
  out.push(`${pad})`);
  return out;
}

/* ─── `if` / `assert` / `switch` 三格模板（lower.js:12544-12680）───────────────── */

/** `if (C) T [else E]` —— 方言直接有这一格。 */
export function ifLines(condText, thenBody, elseBody, pad) {
  if (elseBody === null || elseBody === undefined) return [`${pad}(if ${condText}`, thenBody, `${pad})`];
  return [`${pad}(if ${condText}`, thenBody, elseBody, `${pad})`];
}

/**
 * **一个结点在源码里的原样文本**：换行连同紧跟其后的那串空白收成一个空格 —— 与 jancy 的
 * `Token::getText(list)` 同一条（axl_lex_RagelLexer.h:52-84：没有换行就**直接切一段源码**，
 * 有换行则把 `\n` 及其后的连续空白换成单个空格）。所以"条件的文本"不是重排出来的，
 * 是照 jancy 的做法从源码里切的 —— 一个字节都不用猜。
 */
export function srcTextOf(span) {
  if (span === null || span === undefined) return null;
  const f = span.file;
  if (f === null || f === undefined || typeof f.text !== 'string') return null;
  return f.text.slice(span.start, span.end).replace(/\n[ \t\r\n\f\v]*/g, ' ');
}

/**
 * `assert(C)` / `assert(C, "话")`（第四十九刀）。jancy 摊成两块：真跳 `assert_continue`、
 * 假跳 `assert_fail`，后者调 `assertionFailure(文件, 行, 条件文本, 话)`
 * （jnc_ct_Parser.cpp:3798-3825），印的是 `"%s(%d): assertion failure: %s"`，带话的再追
 * `" (%s)"`，然后 `dynamicThrow()`（jnc_rtl_CoreLib.cpp:534-541）。行号是**条件第一个 token
 * 那一行**（1 起）。
 *
 * 方言不用新形式：`(fail E)` 就是"印一句、退 70"，五条腿都有。于是落成
 * `(if (un "!" C) (do (fail (str 那句话))))` —— 与 jancy 的两块一一对上，只是"抛"换成"停"
 * （这一层还没有异常，`try`/`throw` 都在边界上）。
 *
 * 两处明写的差别：
 *   - 第二个实参在 jancy 的产生式里**写死是字面量**（Stmt.llk:415），所以收表达式会让
 *     "运行期才知道那句话"变成能写的东西，而 jancy 写不出来；相邻字面量拼接照收；
 *   - jancy 的 assert 由 `-a`/`--assert` 点亮（没开就**整条丢掉**、条件都不求值），
 *     这一层没有开关机构，选的是**一直开着** —— 反过来那头是"断言失败静静地过"，
 *     而这条线靠"跑起来对不对"往前走，那种沉默最不能要。
 */
export function assertLines(condText, path, line, text, msg, pad) {
  const extra = msg === null || msg === undefined ? '' : ` (${msg})`;
  const words = `${path}(${line}): assertion failure: ${text}${extra}`;
  return [
    `${pad}(if (un "!" ${condText})`,
    `${pad}  (do`,
    `${pad}    (fail (str ${JSON.stringify(words)}))))`,
  ];
}

/**
 * `switch` —— 方言里没有它，所以摊成「**派发下标 + 一串守卫**」（第三十六刀）：
 *
 *   (let $svN int COND)
 *   (let $skN int (int 组的个数))            ;; 一个都不中时指向"组的个数"，于是哪一组都不跑
 *   (if (bin "==" (var $svN) (int k)) (set $skN (int 组号)))   ;; 每个 case 一条
 *   (while (bool true)
 *     (do
 *       (if (bin "<=" (var $skN) (int 0)) (do 第0组))
 *       (if (bin "<=" (var $skN) (int 1)) (do 第1组))
 *       …
 *       (brk)))
 *
 * 三件事靠这个形状同时成立：
 *   1. **贯穿**：case 的值互不相同，所以派发那几条 `if` 次序无关；守卫是 `<=`，从第 j 组进去
 *      就接着跑 j+1、j+2 …… —— 正是 C 与 jancy 的贯穿（cflow_switch.rst:29）；
 *   2. **break 跳出整个 switch**：那圈 `while` 只跑一遍（体的末尾就是 `(brk)`），所以里面的
 *      `(brk)` 落到 switch 之外；
 *   3. **每组一层作用域**：jancy 给每个 case 块隐式开一层（cflow_switch.rst:15），所以
 *      `case 0: int i = 10;` 与 `case 1: int i = 20;` 不冲突 —— 每组包一个 `(do …)`。
 *
 * 那圈 `while` 是**合成的**：`break` 数它（jancy 也把 switch 算一层，cflow_switch.rst:37）、
 * `continue` 不数它 —— switch 里的 `continue` 落成 `(cont 2)`，跳过这一圈回到外面那个真循环。
 */
export function switchLines({
  sv, sk, condText, cases, groups, pad,
}) {
  const out = [
    `${pad}(let ${sv} int ${condText})`,
    `${pad}(let ${sk} int (int ${groups.length}))`,
  ];
  for (const { value, group } of cases) {
    out.push(`${pad}(if (bin "==" (var ${sv}) (int ${value})) (set ${sk} (int ${group})))`);
  }
  out.push(`${pad}(while (bool true)`);
  out.push(`${pad}  (do`);
  for (const [i, body] of groups.entries()) {
    out.push(`${pad}    (if (bin "<=" (var ${sk}) (int ${i}))`);
    out.push(`${pad}      (do`);
    out.push(body);
    out.push(`${pad}      )`);
    out.push(`${pad}    )`);
  }
  out.push(`${pad}    (brk)`);
  out.push(`${pad}  )`);
  out.push(`${pad})`);
  return out;
}

/**
 * `return` 那一族（lower.js:13021-13070）。按次序问，答 `{ kind, lines?, why? }`：
 *
 *   1. **光一个 `return`**：函数回 void 就是 `(ret)`；不回 void 就报"光一个 return 不够"；
 *   2. 函数回 void、**在 main 里**、后面是字面的 `0`：`int main()` 降成方言的 `(main …)`，
 *      那个入口不回值，所以 `return 0` 就是 `(ret)`。**只放过字面 0** —— `return 1` 是
 *      "非零退出码"，这一层还没有那一格，当场说清；
 *   3. 函数回 void、**不在 main 里**、后面是**一格 void 调用**（第二百四十八刀，语料 71 处）：
 *      jancy 那边这条合法，走的正是"光一个 return"那条路 —— 一格 void 调用的 `Value` 是空的
 *      （`Value::setVoid`），于是 `ControlFlowMgr::ret` 里 `if (!value)` 为真
 *      （jnc_ct_ControlFlowMgr.cpp:470-488）：底下那次调用照旧发出去，只是没有值往回带。
 *      所以落法是"按语句降那条调用，再发一句 `(ret)`"，一个字都不用新造；
 *   4. 函数回 void、后面跟的**问得出类型**（字面量、回值的函数…）：报错，照 jancy 那句
 *      "void function 'X' returning 'Y' value"；
 *   5. 有返回类型又带值：`(ret 值)`。
 */
export function returnKind({
  hasValue, retVoid, inMain, isLiteralZero, valueTypeName,
}) {
  if (!hasValue) {
    return retVoid ? { kind: 'ret' } : { kind: 'error', why: '这个函数回值，光一个 return 不够' };
  }
  if (!retVoid) return { kind: 'ret-value' };
  if (inMain === true) {
    if (isLiteralZero === true) return { kind: 'ret' };
    return { kind: 'not-yet', why: 'main 里 `return` 一个非 0 的值（方言的入口没有退出码）' };
  }
  if (valueTypeName !== null && valueTypeName !== undefined) {
    return {
      kind: 'error',
      why: `这个函数回 void，'return' 后面却跟了一格 ${valueTypeName} 的值`
        + '（jancy 那边同：ControlFlowMgr::ret 里那句 "void function returning ... value"）',
    };
  }
  return { kind: 'expr-then-ret' };                                  // 一格 void 调用
}
