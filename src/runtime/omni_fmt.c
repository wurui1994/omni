/* 值 -> 文本。两套规则，刻意分开（ADR-0005）：
   打印用 %.6g（看值用的，不追求往返）；序列化用 repr（要求 strtod 能往返回原值）。 */
#include "omni.h"
/* omni_run_proc 要 WIFEXITED/WEXITSTATUS —— omni.h 里那批标准头不含它。 */
#include <sys/wait.h>

omni_str omni_str_int(int64_t v) { return omni_str_fmt("%lld", (long long)v); }
omni_str omni_str_real(double v) { return omni_str_fmt("%.6g", v); }

/* `(tostr E N)`：按 N 位有效数字。位数由方言限死在 1..17（那里检查，这里只兜底），
   因为 %.0g 在 C 里没有定义，而超过 17 位对 double 没有意义。 */
omni_str omni_str_realg(double v, int64_t p) {
  int n = (int)p;
  if (n < 1) n = 1;
  if (n > 17) n = 17;
  return omni_str_fmt("%.*g", n, v);
}

/* `(sfix E N)`：C 的 `%.Nf`（ADR-0016 第八刀）。位数的范围是 0..30；它**不必**是字面量
   （第二十八刀 —— `printf("%.*f", n, x)` 那一行），所以越界在这儿是**运行期错误**，四条腿
   同一句话。这一条就是 C 的 printf 本身 —— 它才是那个"就近取偶"的出处，另外三条腿是照它
   写的（JS 的 toFixed 在恰好一半上进位，所以那边不能用它，见 native.js）。 */
omni_str omni_str_fixed(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("sfix precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%.*f", (int)p, v);
}

/* `(ssci E N)`：C 的 `%.Ne`（第三十刀）。与上面同一条 —— 这一行就是那四条腿照着写的出处
   （指数至少两位、一定带符号、进位顶到下一格时指数加一，全是 C 库自己给的）。 */
omni_str omni_str_sci(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("ssci precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%.*e", (int)p, v);
}

/* `(sgen E N)` / `(sgenk E N)`：C 的 `%.Ng` / `%#.Ng`（第三十一刀）。这两行同样就是出处 ——
   `%g` 那一套（精度 0 等于 1、按舍入之后的指数在 `%e` 与 `%f` 里挑、`#` 不去尾随零）在这儿
   一个字都不用写，是 C 库自己给的；另外三份是照它搭出来的（见 native.js 的 fmtGen）。 */
omni_str omni_str_gen(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("sgen precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%.*g", (int)p, v);
}

omni_str omni_str_genk(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("sgenk precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%#.*g", (int)p, v);
}

omni_str omni_str_bool(bool v) { return omni_str_new(v ? "true" : "false", v ? 4 : 5); }
omni_str omni_str_string(omni_str v) { return v; }

void omni_print_int(int64_t v) { printf("%lld\n", (long long)v); }
void omni_print_real(double v) { printf("%.6g\n", v); }
void omni_print_bool(bool v) { printf("%s\n", v ? "true" : "false"); }
void omni_print_string(omni_str v) { printf("%.*s\n", (int)v.len, v.p); }

/* `(write E)` —— 印一个 string，**不加换行**（ADR-0016 第四刀）。
   jancy 的 `printf("%d ", x)` 到处都是，而 print 自带换行 —— 原先这一格只有 JS 后端有，
   于是那一侧只能把"格式串必须以 \n 收尾"当边界，那是让语言向方言妥协。
   只有 string 一个签名：要印数就在方言那一层先 (tostr …)。 */
void omni_write_string(omni_str v) { printf("%.*s", (int)v.len, v.p); }

/* `(readtext E)`：把一份文本文件**整份**读进来。核心方言里读文件只有这一个口子 ——
   asy 的 `input(name)` 那一族（line/word 的分词、注释、eof）都在被降级的语言那一侧搭，
   这里只管把字节拿到手。一次读完（不流式），与 omni_js_fs_read_text 同一条理由：
   读的是数据文件，尺寸已知。读不到就是运行期错误（asy 那边 `input(name)` 默认
   check=true，也是当场退出）。 */
omni_str omni_read_text(omni_str path) {
  char *p = omni_cstr(path);
  FILE *f = fopen(p, "rb");
  if (!f) omni_errorf("cannot read '%s': %s", p, strerror(errno));
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); omni_errorf("cannot seek '%s'", p); }
  long n = ftell(f);
  if (n < 0) { fclose(f); omni_errorf("cannot size '%s'", p); }
  rewind(f);
  char *buf = omni_alloc_bytes(n + 1);
  size_t got = n > 0 ? fread(buf, 1, (size_t)n, f) : 0;
  fclose(f);
  buf[got] = 0;
  return omni_str_new(buf, (int64_t)got);
}

/* `(getenv E)`：读宿主的一格环境设置。没这一格回空串 —— "没设"是常态，调用方拿它当
   "用默认值"（asy 的输出格式就是这么读的，见 ADR-0015）。getenv 回的那块内存是
   environ 自己的，omni_str_new 会照抄一份，所以不用管它的生命周期。 */
omni_str omni_get_env(omni_str name) {
  const char *v = getenv(omni_cstr(name));
  if (!v) return omni_str_new("", 0);
  return omni_str_new(v, (int64_t)strlen(v));
}

/* `(writetext P E)`：整份写一份文本文件。回写进去的字节数。 */
int64_t omni_write_text(omni_str path, omni_str text) {
  char *p = omni_cstr(path);
  FILE *f = fopen(p, "wb");
  if (!f) omni_errorf("cannot write '%s': %s", p, strerror(errno));
  int64_t n = omni_str_len(text);
  if (n > 0) {
    if (fwrite(text.p, 1, (size_t)n, f) != (size_t)n) {
      fclose(f);
      omni_errorf("cannot write '%s': %s", p, strerror(errno));
    }
  }
  if (fclose(f) != 0) omni_errorf("cannot write '%s': %s", p, strerror(errno));
  return n;
}

/* `(runproc CMD)`：`/bin/sh -c CMD`，回退出码。子进程的两个流都丢掉 —— 这一层的
   stdout 是产物本身（asy 那边就是 EPS），被调程序的絮絮叨叨混进去会把图弄坏。
   **必须套一层子 shell**：`CMD >/dev/null` 里的重定向只管命令表的最后一条，
   量出来过 —— `echo LEAK; echo LEAK 1>&2 >/dev/null 2>&1` 照样把第一个 LEAK 印出来，
   而 `printf ok > f >/dev/null 2>&1` 后面那个重定向赢了，f 里什么都没有。
   `(` 与 `)` 之间垫一个换行：CMD 末尾要是个 `#注释`，`)` 会被注掉。
   跑不起来（system 回 -1）回 127，与 JS 那条腿一致。

  **stdin 也必须重定向** —— 而且不是"讲究"，是量出来的病：asy 的 `_texpath` 要拿 gs 跑
  一份 .ps 换轮廓，gs 打了 `-P` 仍会在行尾印 `>>showpage, press <return> to continue<<`
  然后**读一行 stdin** 等回车。`system()` 的两个流是继承的，stdin 于是还是那个终端 ——
  永不 EOF，于是 `run-c tests/asy/examples/bars3.asy` 输出全写完（6 MB，连 `%%EOF` 都在）
  却永远不退出，`timeout 60` 只能杀掉（参考 asy 自己 3.585s）。给 `< /dev/null` 就 4.7s
  正常收工，量得清清楚楚。
  JS 那条腿（backend-js/prelude.js 的 `$run_proc`）用 `stdio: ["ignore", ...]`，天生没有
  这一格；C 这边的 `system()` 没有那个开关，所以只能在命令行上补 —— 与另外两个流同一处。 */
int64_t omni_run_proc(omni_str cmd) {
  char *c = omni_cstr(cmd);
  size_t n = strlen(c);
  size_t cap = n + 40;
  char *line = omni_alloc_bytes((int64_t)cap);
  snprintf(line, cap, "( %s\n) </dev/null >/dev/null 2>&1", c);
  int r = system(line);
  if (r == -1) return 127;
  if (WIFEXITED(r)) return WEXITSTATUS(r);
  return 128;
}

/* 末尾补 ".0"：否则整数值的 real 序列化成 "1000"，再解析回来就变成 int 了 ——
   往返要保类型，不只是保数值。 */
static omni_str omni_repr_tail(const char *s) {
  if (strchr(s, '.') || strchr(s, 'e')) return omni_str_fmt("%s", s);
  return omni_str_fmt("%s.0", s);
}

/* 取 15/16/17 位里第一个能往返的：这是"最短往返"的廉价近似，不需要 Grisu/Ryu，
   而且两个后端做的是同一件事，结果逐位一致。 */
omni_str omni_repr_real(double v) {
  if (!isfinite(v)) omni_error("cannot represent non-finite real");
  char buf[64];
  for (int p = 15; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*g", p, v);
    if (strtod(buf, NULL) == v) return omni_repr_tail(buf);
  }
  snprintf(buf, sizeof buf, "%.17g", v);
  return omni_repr_tail(buf);
}
