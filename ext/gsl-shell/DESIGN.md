# ext/gsl-shell —— 增量：**语法里加一个节点，字符串里嵌一门小语言**

gsl-shell 是 LuaJIT 2 的变体。它对语言动的手脚分两层，形状完全不同，所以分两节写：

- **语法层**：短函数 `|x| expr`（改的是 LuaJIT 的解析器）
- **字符串层**：公式子语言 `y ~ x1 + x2 | enums : conds`（写在 Lua 字符串里，由 `gdt`
  那族函数自己解析）

判据（`../lua/DESIGN.md` 第 9 节判据 2）是：**加一门方言 = 加一张增量表**，`ext/lua` 与驱动器
一个字不改。第一层已经这么落地了；第二层的落地方式在第 3 节。

---

## 1. 语法层：`|x| e`（已落地，`lang.js`，20 行）

出处（读的是 gsl-shell 自带的那支 LuaJIT，不是猜的）：

- `luajit2/src/lj_parse.c:1905-1945` —— `#ifdef GSH_SHORT_FSYNTAX` 里的 `parse_simple_body`：
  形参用 `parse_params_ext(ls, 0, '|', '|')`，与 `( )` 那套形参机器**同一份**（所以照样收 `...`）；
  函数体是**一个表达式**，隐式 `return`（`fs.flags |= PROTO_HAS_RETURN`）
- `luajit2/src/lj_parse.c:2086-2091` —— `expr_simple` 里的 `case '|'`：它是**简单表达式**的一支，
  所以 `|x| e` 能出现在任何表达式位置

增量表因此只有两行数据：`punct: ['|']` 与一个节点

```js
{ name: 'lambda', of: 'exp', syn: ['|', nm('names', {min:0, vararg:true}), '|', h('body')] }
```

**驱动器没改**：`syn` 以字面记号 `|` 起头、`of: 'exp'`，`lang.js` 的 `SIMPLE` / `expLead`
索引自动收它；作用域与元数也不必新写 —— 它与 `funcbody` 同形（`['open','bind:names','body']`），
`values.js` 里它产出一格。

量到的（`node ext/lua/tests/sweep.js --gsl`、`node ext/lua/tests/gen.js --gsl`）：

- 语料（gsl-shell 自己的 112 个 `.lua`）：**收 112/112，写回幂等 112/112**
  （纯 Lua 尺子只收 90 —— 差的 22 个正是用 `|x| e` 的文件）
- 生成尺子：412 格分歧 0，另有 **39 格没外部尺子**

### 记明的一笔账：本机的 luajit 是另一支方言

```
$ luajit -e 'local f = |x| x'        →  '->' expected near 'x'
$ luajit -e 'local f = |x| -> x'     →  收
```

本机这支 LuaJIT 2.1 的短函数要写 `|x| -> e`；gsl-shell 那支（`GSH_SHORT_FSYNTAX`）不要箭头，
而它只有源码没编出来。于是：

- `|x| e` 的那些格在 `lang.js` 里标了 `noOracle`，生成尺子**跳过**它们（不假装量过），
  由语料尺子担着；
- 另写了一张 `ext/luajit/lang.js`（`|x| -> e`）—— 它有真尺子，**451 格分歧 0**，
  用来证明"增量表这套机制"本身是对的。

两支方言差一个记号，而增量表各自 20 行、驱动器共用 —— 这就是这套设计想要的形状。

## 2. 字符串层：公式子语言（`expr-parse.lua`）

它**不是** Lua 的语法，是写在字符串里的 DSL：`gdt.lm(data, "y ~ x1 + x2")` 这样用。
文法照抄自 `expr-parse.lua`（行号是那份文件里的）：

```
schema          ::= expr '~' expr_list [enums] [conds] EOF      (:131-140)
schema_multivar ::= expr_list '~' expr_list [enums] [conds] EOF (:141-150)
enums           ::= '|' ident_list                              (:118-123)
conds           ::= ':' expr_list                               (:125-130)
expr_list       ::= expr {',' expr}                             (:98-106)
ident_list      ::= ident {',' ident}      -- 只收裸名字（:108-116, :55-66）
expr            ::= ['-'] factor {oper factor}   -- 爬优先级（:68-96）
factor          ::= ident                                       (:20-27)
                  | ident '(' expr ')'   -- 函数求值（:24-26）
                  | literal | number                            (:29-38)
                  | '(' expr ')'                                 (:39-43)
                  | '%' ident            -- enum 引用（:44-52）
```

算符与档次照 `expr-lexer.lua:11`（`max_oper_prio = 4`，见 `:16`）：

```
and or        0
= != > >= < <= 1
+ -           2
* /           3
^             4
%             -1   ← 它不是二元算符，只是 enum 的前缀记号（factor 里单独处理）
```

三件值得注意的事（都会影响怎么落地）：

1. **`=` 是比较**，不是赋值（`:11` 的 `oper_table`）—— 与 Lua 相反；
2. **没有一元 `not`**，一元只有 `-`，而且只在最外层（`prio == 0`，`:79`）；
3. `%` 的"负档次"是个哨兵：它保证 `%` 永远走不到二元那条路上。

## 3. 怎么落地：**嵌套语言表**（已落地，`formula.js`）

公式与 Lua 的节点表**不冲突**，因为它压根不在 Lua 的语法里。所以不要把公式的节点塞进
`gslLang` —— 那会让 `|` `~` `%` 这些记号在 Lua 侧凭空多出含义。落地形状应当是：

1. 用同一套 `defineLang` 立**一门独立的小语言** `gslFormulaLang`：
   - 洞的类别只要一类 `formula-exp`（上位链一条都不用）；
   - 节点约 8 个：`schema` / `enum-ref` / `func-eval` / `ident` / `number` / `literal` /
     `prefix` / `binop`；
   - 算符表就是上面那五档 —— **`parse.js` 的五台机器一台都不用改**（优先级爬升、
     `matchSyn`、有序选择都是语言无关的）。
2. 在 Lua 侧加一张**嵌套语言表**：`{函数名 → 第几个实参 → 用哪门语言解析}`，
   例如 `gdt.lm` 的第 2 个实参是 `gslFormulaLang`。这张表是数据，检查器读它 ——
   于是"字符串里嵌 DSL"这件事也变成一条规则，而不是一段特判。
3. 尺子：语料里所有 `gdt.*` 调用的字符串实参都拿出来喂给公式语言（收不收 + 写回幂等），
   再对着 `expr-print.lua` 的输出比对（那是 gsl-shell 自己的打印器，可以当尺子）。

落地后量到的（`node ext/gsl-shell/tests/formula.js`）：语料 80 条（`.lua`/`.rst` 里带 `~`
的字符串）+ 生成 96 条，**树对得上 176/176、写回幂等 176/176**。尺子是他们自己的
`expr-parse.lua` —— 它的 `actions` 本来就是参数，所以语法判断全归他们，动作换成一套
只写规范 S 表达式的中立动作，分歧就只可能出在"我的表对不对"上。

三处与 Lua 不同的地方都被尺子确认了：`=` 是比较、`^` 左结合、一元 `-` 只在最外层
（所以 `y ~ a * -b` 该拒 —— 我先前收，加了算符表上的 `onlyAt` 那一格才对上）。

当前还剩一笔明账：`../lua/DESIGN.md` 第 6 节的**降级**（第二条腿）。
