/* ext/r/rt/omni_rhost.c —— 把 libR 摆到 JS 这台"机器"上的那一层（ADR-0047 第二十一格）。
 *
 * 编得过、链得起、装得上之后，真要跑 R 还差两样，都不是编译器的事，是**宿主**的事：
 *
 *   1. **控制台那几格**（`ptr_R_WriteConsole` 一族）：R 的输出走这几个函数指针，
 *      本来由 `Rf_initialize_R`（unix/system.c）摆好。那一句要 argv / 文件系统 /
 *      locale 一整套，我们这条腿上不叫它，所以自己摆：文字打到 stdout。
 *      不摆的症状是 `call of a null function pointer`（printutils -> system 那一跳）。
 *   2. **顶层上下文**（`R_Toplevel` + `R_GlobalContext`）：R 出错要沿着上下文链往上跳，
 *      没有它就是在空链上转圈（量出来：`eval` 一去不回，45 秒 timeout 砍掉）。
 *      这一段照 `main.c` 的 `setup_Rmainloop`（984-999 行）抄。
 *
 * 求值走 **`R_tryEval`** 而不是 `Rf_eval`：它自己摆一个 `SETJMP` 的上下文，
 * R 里的错误于是回到我们手上（`*err` 非 0），不会 longjmp 到天外
 * （那一格量出来是 `longjmp: 这个 jmp_buf 没有被 setjmp 装过`）。
 */

#ifdef HAVE_CONFIG_H
#include <config.h>
#endif
#include <stdint.h>
#ifndef SIZE_MAX
#define SIZE_MAX ((size_t)-1)
#endif
#define R_USE_SIGNALS 1
#include <Defn.h>
#include <R_ext/Parse.h>
#define R_INTERFACE_PTRS 1
#include <Rinterface.h>

/* 一句 R 进来（C 里的字符串常量），一个 double 出去。
   出错不静默：解析不过回 -1、值不是数回 -2。 */
double omni_eval1(const char *src) {
  SEXP txt = PROTECT(Rf_mkString(src));
  ParseStatus st = PARSE_NULL;
  SEXP exprs = PROTECT(R_ParseVector(txt, -1, &st, R_NilValue));
  if (st != PARSE_OK) { UNPROTECT(2); return -1.0; }
  SEXP val = R_NilValue;
  for (int i = 0; i < Rf_length(exprs); i++) {
    int err = 0;
    val = R_tryEval(VECTOR_ELT(exprs, i), R_GlobalEnv, &err);
    if (err) { UNPROTECT(2); return -3.0; }
  }
  if (!Rf_isNumeric(val)) { UNPROTECT(2); return -2.0; }
  double d = Rf_asReal(val);
  UNPROTECT(2);
  return d;
}

/* 一格更小的探子：`+` 那个 BUILTINSXP 的 C 函数指针取出来看看是不是 0。 */
double omni_probe_plus(void) {
  SEXP sym = Rf_install("+");
  SEXP fun = SYMVALUE(sym);
  if (fun == R_UnboundValue) return -1.0;
  if (TYPEOF(fun) != BUILTINSXP && TYPEOF(fun) != SPECIALSXP) return -2.0;
  return PRIMFUN(fun) == NULL ? 0.0 : 1.0;
}


/* 控制台那几格的功能映射（路线里"非纯计算的部分做合理映射"那一条）：
   R 的输出走 ptr_R_WriteConsole / R_Outputfile，这两格本来由 Rf_initialize_R
   （unix/system.c）摆好 —— 我们没叫那一句，所以自己摆：文字打到 stdout。
   不摆的症状是 call of a null function pointer（printutils -> system 那一跳）。 */
int printf(const char*, ...);
/* Defn.h 里 R_Toplevel 那一条被 extern0 包着（只在 main.c 那一份里现身），
   所以这儿自己声明一次 —— 类型 RCNTXT 是 Defn.h 给的。 */
extern RCNTXT R_Toplevel;
/* `R_ReplFile` 在 Defn.h 里是 attribute_hidden 的（只在 main.c 那一份里现身）。 */
/* `R_Home` 是 `Rf_initialize_R` 从 `getenv("R_HOME")` 填的那一格（Defn.h 里 extern0）——
   我们不叫那一句，所以自己填：`R_OpenLibraryFile` 就是按它拼
   `R_HOME/library/base/R/base` 这条路。量出来不填就是 fp == NULL（回 -1）。 */
extern char *R_Home;
char *getenv(const char *);

static void omni_wc(const char *buf, int len) { printf("%.*s", len, buf); }
static void omni_msg(const char *s) { printf("%s", s); }
static void omni_noop(void) { }
static void omni_busy(int which) { (void)which; }
static void omni_suicide(const char *s) { printf("R_Suicide: %s\\n", s); }

/* **locale 那一格的功能映射**（第二十九格）：这条腿上字符集就是 UTF-8。
 *
 * R 本来在 `Rf_initialize_R` 里 `setlocale(LC_CTYPE, "")` 之后按 `MB_CUR_MAX` 摆
 * `mbcslocale` / `utf8locale`（util.c 的那两个全局）。我们不叫那一句，于是两个都是
 * FALSE —— 症状是**静默答错**：`nchar("héllo")` 回 6（按字节数）而不是 5（按字符数）。
 * 这一格明着摆上：字符集 UTF-8、是多字节 locale、不是 latin1。 */
void omni_locale_init(void) {
  utf8locale = TRUE;
  mbcslocale = TRUE;
  latin1locale = FALSE;
  known_to_be_utf8 = TRUE;
  known_to_be_latin1 = FALSE;
}

/* 顶层上下文（main.c 的 setup_Rmainloop 那一段）：R 的出错那条路要沿着
   R_GlobalContext 往上跳，没有它就是在空链上转圈（量出来：eval 一去不回）。 */
void omni_toplevel_init(void) {
  R_Toplevel.nextcontext = NULL;
  R_Toplevel.callflag = CTXT_TOPLEVEL;
  R_Toplevel.cstacktop = 0;
  R_Toplevel.gcenabled = R_GCEnabled;
  R_Toplevel.promargs = R_NilValue;
  R_Toplevel.callfun = R_NilValue;
  R_Toplevel.call = R_NilValue;
  R_Toplevel.cloenv = R_BaseEnv;
  R_Toplevel.sysparent = R_BaseEnv;
  R_Toplevel.conexit = R_NilValue;
  R_Toplevel.vmax = NULL;
  R_Toplevel.nodestack = R_BCNodeStackTop;
  R_Toplevel.bcprottop = R_BCProtTop;
  R_Toplevel.cend = NULL;
  R_Toplevel.cenddata = NULL;
  R_Toplevel.intsusp = FALSE;
  R_Toplevel.handlerstack = R_HandlerStack;
  R_Toplevel.restartstack = R_RestartStack;
  R_Toplevel.srcref = R_NilValue;
  R_Toplevel.prstack = NULL;
  R_Toplevel.evaldepth = 0;
  R_Toplevel.browserfinish = 0;
  R_GlobalContext = &R_Toplevel;
  R_ToplevelContext = &R_Toplevel;
  R_SessionContext = &R_Toplevel;
  R_ExitContext = NULL;
  R_Warnings = R_NilValue;
}

void omni_console_init(void) {
  R_Outputfile = 0;
  R_Consolefile = 0;
  ptr_R_WriteConsoleEx = 0;
  ptr_R_WriteConsole = omni_wc;
  ptr_R_ShowMessage = omni_msg;
  ptr_R_ResetConsole = omni_noop;
  ptr_R_FlushConsole = omni_noop;
  ptr_R_ClearerrConsole = omni_noop;
  ptr_R_Busy = omni_busy;
  ptr_R_Suicide = omni_suicide;
}

double omni_eval_1p1(void) { return omni_eval1("1+1"); }
double omni_eval_sum(void) { return omni_eval1("sum(1:10)"); }
double omni_eval_sd(void) { return omni_eval1("sd(c(1,2,3,4))"); }

/* **把 base 那个包的 R 代码装进来**（第二十三格）。
 *
 * `nchar` / `paste0` / `sd` 这些不是 C 写的，是 base 包里的 R 函数（身子只有一句
 * `.Internal(...)`）。R 自己在 `setup_Rmainloop`（main.c 1045-1073）里这么装：
 * `Init_R_Variables(R_BaseNamespace)` 之后打开 `R_HOME/library/base/R/base`
 * （一份序列化过的 lazy-load 库），交给 `R_ReplFile` 一句一句跑。
 *
 * 要 `R_HOME` —— 那是 `getenv("R_HOME")`，判据那边把它指到我们自己编装的那棵树。
 * 回 0 是装上了、-1 是打不开那份文件。 */
int omni_base_init(void) {
  SEXP baseNSenv = R_BaseNamespace;
  FILE *fp;
  int errs = 0;
  if (R_Home == NULL) R_Home = getenv("R_HOME");
  if (R_Home == NULL) return -2;
  Init_R_Variables(baseNSenv);
  fp = R_OpenLibraryFile("base");
  if (fp == NULL) return -1;
  /* `R_ReplFile` 本身是 `attribute_hidden`（main.c 里的文件局部），跨模块调不到 ——
     报的是 `R_ReplFile: libc: 没有这个函数`，**loud 不 silent**，正是要的。
     所以这一圈自己写：`R_Parse1File` 一句一句读，`R_tryEval` 一句一句在 base 的
     命名空间里跑（R 自己那一圈的形状，只是错误回到我们手上而不是 longjmp 出去）。 */
  for (;;) {
    ParseStatus st = PARSE_NULL;
    SEXP e = R_Parse1File(fp, 1, &st);
    int err = 0;
    if (st == PARSE_EOF) break;
    if (st == PARSE_NULL) continue;
    if (st != PARSE_OK) { errs += 1000; break; }
    PROTECT(e);
    R_tryEval(e, baseNSenv, &err);
    UNPROTECT(1);
    if (err) errs += 1;
  }
  fclose(fp);
  return errs;
}

/**
 * **一段一段装 base**（开机镜像那条路，第二十四格）。
 *
 * 装整份 base 要一分钟（1400 多句、约 30 句/秒），而"一趟不许超过一分钟"。所以拆开：
 * 从字节偏移 `from` 开始、最多跑 `cap` 句，把停下来的偏移写回 `endpos`。
 * 外头那个 builder（`ext/r/build-rimage.js`）一轮存一次内存像、下一轮铺回去接着跑 ——
 * 于是"一次一分钟"变成"四次各四十秒"，而结果是同一份像。
 *
 * 回 0 = 到文件尾了（装完），1 = 还有，负数 = 出错（-1 打不开、-2 没 R_HOME）。
 */
int omni_base_step(long long from, int cap, long long *endpos, int *nerr) {
  SEXP baseNSenv = R_BaseNamespace;
  FILE *fp;
  int n = 0;
  int errs = 0;
  int more = 1;
  if (R_Home == NULL) R_Home = getenv("R_HOME");
  if (R_Home == NULL) return -2;
  if (from == 0) Init_R_Variables(baseNSenv);
  fp = R_OpenLibraryFile("base");
  if (fp == NULL) return -1;
  if (from > 0) fseek(fp, (long)from, 0);
  for (;;) {
    ParseStatus st = PARSE_NULL;
    SEXP e;
    int err = 0;
    if (n >= cap) break;
    e = R_Parse1File(fp, 1, &st);
    if (st == PARSE_EOF) { more = 0; break; }
    if (st == PARSE_NULL) continue;
    if (st != PARSE_OK) { errs += 1000; more = 0; break; }
    PROTECT(e);
    R_tryEval(e, baseNSenv, &err);
    UNPROTECT(1);
    n += 1;
    if (err) errs += 1;
  }
  *endpos = (long long)ftell(fp);
  *nerr = errs;
  fclose(fp);
  return more;
}

/* **任意一句 R 从 JS 递进来**：C 这边留一块固定的缓冲，JS 那边把字节写进去
 * （地址问 `omni_src_ptr()`），再叫 `omni_eval_buf()`。
 *
 * 为什么不在 JS 里直接造一个 C 串：那要在 JS 那侧管 malloc 与结尾的 0，两头都容易错；
 * 一块固定缓冲把"谁管这块内存"说得最清楚。4 KB 够判据用（一句一句地试）。 */
static char omni_src_buf[4096];

char *omni_src_ptr(void) { return omni_src_buf; }
int omni_src_size(void) { return (int)sizeof(omni_src_buf); }
double omni_eval_buf(void) { return omni_eval1(omni_src_buf); }
