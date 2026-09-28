/* ext/python/rt/ucase-probe.c —— **只借 unicode 的表**，把 python 的大小写映射做对
 *
 * ## 这一份要证的事
 *
 * `.upper()` / `.lower()` / `.casefold()` / `.title()` 在非 ASCII 上要 unicode 的表
 * （`ext/python/SPEC.md` §一 第 28 条那张账）。但**不必为它借整份运行时**：
 * `Objects/unicodectype.c` 里那几个 `_PyUnicode_To*Full` / `_PyUnicode_Is*` 是**纯函数**
 * —— 码点进、码点出，查的是 `Objects/unicodetype_db.h` 那张表，一格运行时状态都不碰。
 * 量出来：那份 `.o` 是 179KB，链完只欠 libc 的两个符号（`printf` / `strlen`），
 * **不用 Py_Initialize、不用 21M 的产物**。
 *
 * UTF-8 的解与编这一半是**我们自己的**（那是"串怎么表示"的算术，不是 unicode 表）。
 *
 * ## 一处要照抄的规矩：希腊文的**尾位 sigma**
 *
 * `Σ` 小写成 `σ` 还是 `ς` 取决于**上下文**（不在表里）：CPython 的
 * `Objects/unicodeobject.c` 里 `handle_capital_sigma` 说的是 —— 前面（跳过
 * case-ignorable）有一格 cased，而后面（同样跳过）没有 cased，就用 `ς`。
 * 这一份照抄那条规矩，用的还是借来的那两个谓词（`_PyUnicode_IsCased` /
 * `_PyUnicode_IsCaseIgnorable`）。不抄这一条的读数是 8/10（`ΣΣΣ`、`ΌΣΟΣ` 两格差）。
 */
#include <stdio.h>
#include <string.h>
#include "Python.h"
#include "pycore_unicodectype.h"   /* `_PyUnicode_To*Full` / `_PyUnicode_Is*` 的原型 */

#define MAXCP 256

/** 一格字符的码点 + 它占几个字节（回 -1 = 不是合法的起始字节）。 */
static int dec1(const unsigned char *p, int n, unsigned int *cp) {
  unsigned char b0 = p[0];
  int k;
  if (b0 < 0x80) { *cp = b0; return 1; }
  if ((b0 & 0xE0) == 0xC0) { k = 2; *cp = b0 & 0x1F; }
  else if ((b0 & 0xF0) == 0xE0) { k = 3; *cp = b0 & 0x0F; }
  else if ((b0 & 0xF8) == 0xF0) { k = 4; *cp = b0 & 0x07; }
  else return -1;
  if (k > n) return -1;
  for (int i = 1; i < k; i++) *cp = (*cp << 6) | (p[i] & 0x3F);
  return k;
}

static int enc1(unsigned int cp, char *out) {
  if (cp < 0x80) { out[0] = (char)cp; return 1; }
  if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
  }
  out[0] = (char)(0xF0 | (cp >> 18));
  out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
  out[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

/** `Σ` 在第 i 格上该小写成哪一个（照 CPython 的 `handle_capital_sigma`）。 */
static unsigned int sigma_at(const unsigned int *cps, int n, int i) {
  int j = i - 1;
  while (j >= 0 && _PyUnicode_IsCaseIgnorable((Py_UCS4)cps[j])) j--;
  int final = j >= 0 && _PyUnicode_IsCased((Py_UCS4)cps[j]);
  if (final) {
    j = i + 1;
    while (j < n && _PyUnicode_IsCaseIgnorable((Py_UCS4)cps[j])) j++;
    final = j == n || !_PyUnicode_IsCased((Py_UCS4)cps[j]);
  }
  return final ? 0x3C2u : 0x3C3u;
}

/** mode: 0 upper / 1 lower / 2 casefold / 3 title */
static void mapstr(const char *s, int mode, char *out) {
  unsigned int cps[MAXCP];
  int n = 0;
  int at = 0;
  int len = (int)strlen(s);
  while (at < len && n < MAXCP) {
    unsigned int cp;
    int k = dec1((const unsigned char *)s + at, len - at, &cp);
    if (k < 0) { cps[n++] = (unsigned char)s[at++]; continue; }
    cps[n++] = cp;
    at += k;
  }
  int w = 0;
  int prevCased = 0;
  for (int i = 0; i < n; i++) {
    Py_UCS4 res[3];
    int cnt;
    unsigned int cp = cps[i];
    /* casefold（mode 2）**不**走这条上下文规则：python 的 `casefold()` 一律出 `σ`。 */
    int lower = mode == 1 || (mode == 3 && prevCased);
    if (cp == 0x3A3u && lower) {                 /* 尾位 sigma 那一格 */
      res[0] = (Py_UCS4)sigma_at(cps, n, i);
      cnt = 1;
    } else if (mode == 0) cnt = _PyUnicode_ToUpperFull((Py_UCS4)cp, res);
    else if (mode == 1) cnt = _PyUnicode_ToLowerFull((Py_UCS4)cp, res);
    else if (mode == 2) cnt = _PyUnicode_ToFoldedFull((Py_UCS4)cp, res);
    else if (prevCased) cnt = _PyUnicode_ToLowerFull((Py_UCS4)cp, res);
    else cnt = _PyUnicode_ToTitleFull((Py_UCS4)cp, res);
    if (mode == 3) prevCased = _PyUnicode_IsCased((Py_UCS4)cp) ? 1 : 0;
    for (int k = 0; k < cnt; k++) w += enc1((unsigned int)res[k], out + w);
  }
  out[w] = 0;
}

/** FNV-1a（32 位）—— 整张表那一门要一个能对得上的摘要，两侧算法必须逐步相同。 */
static unsigned int fnv(unsigned int h, const char *s) {
  for (const unsigned char *p = (const unsigned char *)s; *p != 0; p++) {
    h = (h ^ *p) * 16777619u;
  }
  return h;
}

int main(int argc, char **argv) {
  char buf[2048];
  /* `--all`：**整张表**过一遍（0..0x10FFFF，跳开代理区 —— 那一段没有合法的 UTF-8），
     四个映射按顺序喂进一个 FNV-1a，只印摘要。python3 那侧同一套算法，比一个数就行。 */
  if (argc == 2 && strcmp(argv[1], "--all") == 0) {
    unsigned int h = 2166136261u;
    char one[8];
    for (unsigned int cp = 0; cp < 0x110000u; cp++) {
      if (cp >= 0xD800u && cp <= 0xDFFFu) continue;
      int n = enc1(cp, one);
      one[n] = 0;
      for (int m = 0; m < 4; m++) {
        mapstr(one, m, buf);
        h = fnv(h, buf);
        h = (h ^ (unsigned char)'|') * 16777619u;
      }
    }
    printf("%u\n", h);
    return 0;
  }
  /* `--blocks`：同一套摘要，但**每 256 个码点一行**（块号 摘要）—— 摘要对不上时
     用它把差异夹到一个块里，再对那 256 格逐个比。 */
  if (argc == 2 && strcmp(argv[1], "--blocks") == 0) {
    char one[8];
    for (unsigned int base = 0; base < 0x110000u; base += 256u) {
      unsigned int h = 2166136261u;
      for (unsigned int cp = base; cp < base + 256u; cp++) {
        if (cp >= 0xD800u && cp <= 0xDFFFu) continue;
        int n = enc1(cp, one);
        one[n] = 0;
        for (int m = 0; m < 4; m++) {
          mapstr(one, m, buf);
          h = fnv(h, buf);
          h = (h ^ (unsigned char)'|') * 16777619u;
        }
      }
      printf("%u %u\n", base, h);
    }
    return 0;
  }
  for (int i = 1; i < argc; i++) {
    for (int m = 0; m < 4; m++) {
      mapstr(argv[i], m, buf);
      printf("%s%s", buf, m == 3 ? "\n" : "|");
    }
  }
  return 0;
}
