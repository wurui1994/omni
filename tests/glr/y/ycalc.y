/* tests/glr/y/ycalc.y —— 真 bison 的那一支（词法在 .l 里，这一份没有）
 *
 * 这一份挑的是**真 .y 才有、我们从前一格也没有**的那些写法，一处一次：
 *   `%{ … %}` 序言、`%union`、`%token <标签> A 258 "别名"`、字符字面量 `'+'`、
 *   `%left "别名"`（用别名参与优先级）、`%type`、`%destructor` / `%printer`（后面还挂符号）、
 *   `%expect`、`%define`、`%glr-parser` + `%dprec`、`%precedence`、`%empty`、
 *   中段动作、命名引用 `exp[left]`、`;` 省掉的候选式、第二个 `%%` 之后的尾声。
 *
 * 判据有三条（tests/glr/run.js 第 5 节）：转出来的文本对上快照、表建得出来、
 * 而 `glr parse` 要**明说**这份语法没有词法段 —— 那不是失败，那是这一支该有的样子。
 */

%{
#include <stdio.h>
/* 这一段里的 `%%`、`{`、`'}'`、"…}…" 都不许把读入器带偏 */
static const char *brace = "}";
%}

%union {
  int   ival;
  char *sval;
}

%token <ival> NUM 258 "number"
%token <sval> ID
%token MINUS "-"
/* 一格里的名字与字符字面量是**两个**记号（`'\n'` 不是 EOL 的别名）—— 只有紧跟在名字
   后面的**串**才是别名（上面那条 `MINUS "-"`）。这一行钉的就是这条口径。 */
%token EOL '\n'

%type <ival> exp
%type <ival> input line

%destructor { free ($$); } <sval>
%printer    { fprintf (yyo, "%d", $$); } <ival>

%expect 0
%define api.pure full
%glr-parser

%left "-" '+'
%left '*' '/'
%precedence NEG
%right '^'

%start input

%%

input : %empty        { $$ = 0; }
      | input line    { $$ = $2; }
      ;

line  : EOL
      | exp EOL       { printf ("%d\n", $1); }
      ;

exp   : NUM                       { $$ = $1; }
      | ID                        { $$ = lookup ($1); }
      | exp[left] '+' exp[right]  { $$ = $left + $right; }
      | exp "-" exp               { $$ = $1 - $3; }
      | exp '*' exp               { $$ = $1 * $3; }
      | exp '/' exp               { $$ = $1 / $3; } %dprec 2
      | "-" exp     %prec NEG     { $$ = -$2; }
      | exp '^' exp               { $$ = pow ($1, $3); }
      | '(' { printf ("("); } exp ')'   { $$ = $3; }

%%

/* 尾声：C 代码，整段丢。里面的 `%token`、`a : b ;` 都不许被当成语法。 */
int
main (void)
{
  return yyparse ();
}
