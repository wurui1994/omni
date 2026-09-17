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
  char *r = d;
  while (n && (*d++ = *s++)) n--;
  while (n--) *d++ = 0;
  return r;
}

char *strcat(char *d, const char *s) {
  char *r = d;
  while (*d) d++;
  while ((*d++ = *s++)) {}
  return r;
}
