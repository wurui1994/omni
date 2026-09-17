/* string.c — 纯计算的字符串/内存函数（第一百四十片）。
 * 零 syscall —— 全是字节搬运，所以这一份一个头都不 include。 */

void *memcpy(void *d, const void *s, unsigned long n) {
  unsigned char *dp = (unsigned char *)d;
  const unsigned char *sp = (const unsigned char *)s;
  while (n--) *dp++ = *sp++;
  return d;
}

void *memmove(void *d, const void *s, unsigned long n) {
  unsigned char *dp = (unsigned char *)d;
  const unsigned char *sp = (const unsigned char *)s;
  if (dp < sp) { while (n--) *dp++ = *sp++; }
  else { dp += n; sp += n; while (n--) *--dp = *--sp; }
  return d;
}

void *memset(void *s, int c, unsigned long n) {
  unsigned char *p = (unsigned char *)s;
  while (n--) *p++ = (unsigned char)c;
  return s;
}

int memcmp(const void *a, const void *b, unsigned long n) {
  const unsigned char *ap = (const unsigned char *)a;
  const unsigned char *bp = (const unsigned char *)b;
  while (n--) {
    if (*ap != *bp) return *ap < *bp ? -1 : 1;
    ap++; bp++;
  }
  return 0;
}

unsigned long strlen(const char *s) {
  const char *p = s;
  while (*p) p++;
  return (unsigned long)(p - s);
}

int strcmp(const char *a, const char *b) {
  while (*a && *a == *b) { a++; b++; }
  return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, unsigned long n) {
  while (n && *a && *a == *b) { a++; b++; n--; }
  return n == 0 ? 0 : (unsigned char)*a - (unsigned char)*b;
}

char *strchr(const char *s, int c) {
  while (*s) { if (*s == (char)c) return (char *)s; s++; }
  return (char)c == 0 ? (char *)s : (char *)0;
}

char *strrchr(const char *s, int c) {
  const char *last = (char *)0;
  while (*s) { if (*s == (char)c) last = s; s++; }
  if ((char)c == 0) return (char *)s;
  return (char *)last;
}

char *strstr(const char *h, const char *n) {
  if (!*n) return (char *)h;
  unsigned long nl = strlen(n);
  while (*h) {
    if (strncmp(h, n, nl) == 0) return (char *)h;
    h++;
  }
  return (char *)0;
}

char *strcpy(char *d, const char *s) {
  char *r = d;
  while ((*d++ = *s++)) {}
  return r;
}

char *strncpy(char *d, const char *s, unsigned long n) {
  /* **正好写 n 字节**，一个不多。上一版是 `while (n && (*d++ = *s++)) n--;`——
   * 拷到那个 NUL 时循环退出，可 `n` 没跟着减，后头补零那一趟就多写一个字节。
   * 量到的是 `strncpy(buf, "ab", 5)` 把第 6 个字节也清了（判据 `libc-str.js`）。 */
  char *r = d;
  unsigned long i = 0;
  while (i < n && s[i] != 0) { d[i] = s[i]; i++; }
  while (i < n) { d[i] = 0; i++; }
  return r;
}

char *strcat(char *d, const char *s) {
  char *r = d;
  while (*d) d++;
  while ((*d++ = *s++)) {}
  return r;
}

/* ---- 后来补的那一批（第一百四十片第十二格）。都是**头文件里早就声明、谁都没实现**的
 * —— 判据（`tests/c/libc-str.js`）一编就在链接那一步报 `符号 '_strcspn' 没有定义`。 */

char *strncat(char *d, const char *s, unsigned long n) {
  char *r = d;
  while (*d) d++;
  unsigned long i = 0;
  while (i < n && s[i]) { d[i] = s[i]; i++; }
  d[i] = 0;                          /* strncat **一定**补零（strncpy 才不补） */
  return r;
}

void *memchr(const void *s, int c, unsigned long n) {
  const unsigned char *p = (const unsigned char *)s;
  unsigned char t = (unsigned char)c;
  for (unsigned long i = 0; i < n; i++) if (p[i] == t) return (void *)(p + i);
  return (void *)0;
}

/* `strspn`/`strcspn`/`strpbrk`：一张 256 位的表，两趟都是 O(n + m)。
 * 表用 char[256] 而不是位图 —— 少一处移位，这一份不比省那 224 字节。 */
unsigned long strspn(const char *s, const char *set) {
  char in[256];
  for (int i = 0; i < 256; i++) in[i] = 0;
  for (const unsigned char *p = (const unsigned char *)set; *p; p++) in[*p] = 1;
  unsigned long n = 0;
  const unsigned char *q = (const unsigned char *)s;
  while (q[n] && in[q[n]]) n++;
  return n;
}

unsigned long strcspn(const char *s, const char *set) {
  char in[256];
  for (int i = 0; i < 256; i++) in[i] = 0;
  for (const unsigned char *p = (const unsigned char *)set; *p; p++) in[*p] = 1;
  unsigned long n = 0;
  const unsigned char *q = (const unsigned char *)s;
  while (q[n] && !in[q[n]]) n++;
  return n;
}

char *strpbrk(const char *s, const char *set) {
  unsigned long n = strcspn(s, set);
  return s[n] ? (char *)(s + n) : (char *)0;
}

char *strdup(const char *s) {
  unsigned long n = strlen(s) + 1;
  char *p = (char *)malloc(n);
  if (p == (char *)0) return p;
  memcpy(p, s, n);
  return p;
}

/* `strtok_r` 是真的那一个，`strtok` 只是它加一格静态状态 ——
 * 那一格**不可重入**（C 标准就是这么定的），所以两个都给，用哪个由调用方选。 */
char *strtok_r(char *s, const char *sep, char **save) {
  if (s == (char *)0) s = *save;
  if (s == (char *)0) return s;
  s += strspn(s, sep);
  if (*s == 0) { *save = s; return (char *)0; }
  char *end = s + strcspn(s, sep);
  if (*end != 0) { *end = 0; end++; }
  *save = end;
  return s;
}

char *strtok(char *s, const char *sep) {
  static char *save = (char *)0;
  return strtok_r(s, sep, &save);
}
