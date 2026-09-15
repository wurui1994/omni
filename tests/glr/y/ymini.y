/* tests/glr/y/ymini.y —— 混合方言的 .y（词法也写在这一份文件里）
 *
 * 这一份是**判据**，不是示例：它把 glr/yacc.js 认的每一格各占一次 ——
 *   - `%skip` 三种形状：字符类重复（`\s+`）、行注释（`//[^\n]*`）、非贪心的块注释；
 *   - `%lex` 四种落法：带模式的 token、引号串、`word\b` 的关键字、转义过的算符；
 *   - `%token` / `%left` / `%right` / `%prec` / `%start` / 空产生式；
 *   - 动作写成 `{ 标签 }`：转出来就是 `(标签 $1 …)`。
 */

// ===== 词法 =====

%skip WS         \s+
%skip COMMENT    //[^\n]*
%skip BLOCK      /\*[\s\S]*?\*/

%lex NUM         \d+(\.\d+)?
%lex STR         "(?:[^"\\]|\\.)*"
%lex LET         let\b
%lex PRINT       print\b
%lex ID          [a-zA-Z_][a-zA-Z0-9_]*
%lex LE          <=
%lex PLUS        \+
%lex MINUS       -
%lex STAR        \*
%lex SLASH       /
%lex CARET       \^
%lex ASSIGN      =
%lex LT          <
%lex LPAREN      \(
%lex RPAREN      \)
%lex SEMI        ;

// ===== 终结符 =====

%token NUM STR ID
%token LET PRINT
%token PLUS MINUS STAR SLASH CARET ASSIGN LT LE LPAREN RPAREN SEMI

// ===== 优先级（低到高） =====

%left  LT LE
%left  PLUS MINUS
%left  STAR SLASH
%right CARET
%right NEG

%start prog

%%

prog  : stmts                     { prog }
      ;

stmts : stmts stmt                { more }
      | /* empty */               { none }
      ;

stmt  : LET ID ASSIGN expr SEMI   { let }
      | PRINT expr SEMI           { print }
      ;

expr  : expr PLUS expr            { bin }
      | expr MINUS expr           { bin }
      | expr STAR expr            { bin }
      | expr SLASH expr           { bin }
      | expr CARET expr           { bin }
      | expr LT expr              { bin }
      | expr LE expr              { bin }
      | MINUS expr                { neg }   %prec NEG
      | LPAREN expr RPAREN        { paren }
      | NUM                       { num }
      | STR                       { str }
      | ID                        { var }
      ;

%%
