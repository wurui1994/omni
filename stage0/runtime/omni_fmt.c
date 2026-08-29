/* 值 -> 文本。两套规则，刻意分开（ADR-0005）：
   打印用 %.6g（看值用的，不追求往返）；序列化用 repr（要求 strtod 能往返回原值）。 */
#include "omni.h"

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

omni_str omni_str_bool(bool v) { return omni_str_new(v ? "true" : "false", v ? 4 : 5); }
omni_str omni_str_string(omni_str v) { return v; }

void omni_print_int(int64_t v) { printf("%lld\n", (long long)v); }
void omni_print_real(double v) { printf("%.6g\n", v); }
void omni_print_bool(bool v) { printf("%s\n", v ? "true" : "false"); }
void omni_print_string(omni_str v) { printf("%.*s\n", (int)v.len, v.p); }

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
