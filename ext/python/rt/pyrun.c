/* ext/python/rt/pyrun.c —— **拿"整份借来的运行时"跑一份真 `.py`**
 *
 * 与 `embed-probe.c` 的分工：那一份是写死的四行（它量的是"调得通"）；这一份收一个
 * 文件名，于是判据可以是**真库真代码**（asyncio 起一个 TCP server、requests 发一次请求）。
 * 没有它，"第三方库能不能用"这件事只能靠人手试 —— 那不是判据。
 *
 * 口径：
 *   * 薄皮那一格（`omni_py_boot`）与 `embed-boot.c` 共用，不再写第二份配置代码；
 *   * 这一份自己**一句都不印** —— 印的全是借来的运行时（`print`），于是可以与本机
 *     python3 跑同一份脚本逐字节比（两边的 stdout 混在一起次序就不定了）；
 *   * `sys.argv` 也摆上：脚本要知道 site-packages 在哪（判据那侧传进来）。
 */
#include <stdio.h>
#include <stdlib.h>

int omni_py_boot(const char *lib);
int PyRun_SimpleString(const char *s);
int omni_py_fini(void);

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "用法: pyrun <Lib 的路径> <脚本.py> [sys.argv 的其余部分...]\n");
    return 2;
  }
  if (omni_py_boot(argv[1]) != 0) { fprintf(stderr, "pyrun: boot 没起来\n"); return 1; }

  /* sys.argv：脚本名 + 后面那些。写成一句 python 交给运行时，省掉 PyConfig 那一套
     （那一格要 wchar_t 的数组，与这份薄皮的"一个 C 字符串进去"不是一个形状）。 */
  {
    size_t n = 64;
    for (int i = 2; i < argc; i++) n += strlen(argv[i]) + 8;
    char *buf = (char *)malloc(n);
    size_t at = (size_t)snprintf(buf, n, "import sys; sys.argv = [");
    for (int i = 2; i < argc; i++) {
      at += (size_t)snprintf(buf + at, n - at, "%sr'''%s'''", i == 2 ? "" : ", ", argv[i]);
    }
    snprintf(buf + at, n - at, "]");
    if (PyRun_SimpleString(buf) != 0) { fprintf(stderr, "pyrun: sys.argv 摆不上\n"); return 1; }
    free(buf);
  }

  FILE *f = fopen(argv[2], "rb");
  if (f == NULL) { fprintf(stderr, "pyrun: 读不着 %s\n", argv[2]); return 1; }
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *src = (char *)malloc((size_t)len + 1);
  if (src == NULL || fread(src, 1, (size_t)len, f) != (size_t)len) {
    fprintf(stderr, "pyrun: %s 读短了\n", argv[2]);
    return 1;
  }
  src[len] = 0;
  fclose(f);

  int rc = PyRun_SimpleString(src);
  omni_py_fini();
  free(src);
  return rc == 0 ? 0 : 1;
}
