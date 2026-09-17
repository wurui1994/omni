/* 自带 libc 的「纯计算那一半」逐行对账：printf 的旗与长度、snprintf 的截断语义、
 * strtol 一族的边、mem 与 str 那一族的重叠与边界、qsort/bsearch、sscanf。
 *
 * 这一份不问内核（除了最后把结果印出来），所以它在两条腿上都该与平台 libc **逐行相同**。
 * 挑的都是「容易少写一格」的地方：`%#x`、`% d`、`%+.0f`、`%hhd` 的截断、`%.0e`、
 * `snprintf` 装不下时回的是**本来要写多少**、`strtol` 溢出时回 LONG_MAX 且 errno=ERANGE、
 * `memmove` 往后重叠、`strncpy` 不补零、`strcmp` 按 unsigned char 比。
 */
int printf(const char *, ...);
int snprintf(char *, unsigned long, const char *, ...);
int sscanf(const char *, const char *, ...);
long strtol(const char *, char **, int);
unsigned long strtoul(const char *, char **, int);
long long strtoll(const char *, char **, int);
void *memmove(void *, const void *, unsigned long);
void *memset(void *, int, unsigned long);
int memcmp(const void *, const void *, unsigned long);
char *strncpy(char *, const char *, unsigned long);
char *strncat(char *, const char *, unsigned long);
int strcmp(const char *, const char *);
int strncmp(const char *, const char *, unsigned long);
unsigned long strspn(const char *, const char *);
unsigned long strcspn(const char *, const char *);
char *strstr(const char *, const char *);
char *strrchr(const char *, int);
void qsort(void *, unsigned long, unsigned long, int (*)(const void *, const void *));
void *bsearch(const void *, const void *, unsigned long, unsigned long,
  int (*)(const void *, const void *));

static int cmpInt(const void *a, const void *b) {
  int x = *(const int *)a;
  int y = *(const int *)b;
  return x < y ? -1 : (x > y ? 1 : 0);
}

/* backtrace（第十八格）那几格。印的是**布尔**不是地址：地址每次跑都不一样，而
 * 「走出来够不够深、地址互不相同、装不下时截到几层」两边该一样。 */
int backtrace(void **buf, int size);
static void *btBuf[32];
static int btN;
static void bt3(void) { btN = backtrace(btBuf, 32); }
static void bt2(void) { bt3(); }
static void bt1(void) { bt2(); }
static int btDeep(void) { bt1(); return btN >= 4 ? 1 : 0; }
static int btDistinct(void) {
  bt1();
  for (int i = 0; i < 4 && i < btN; i++) {
    for (int j = i + 1; j < 4 && j < btN; j++) if (btBuf[i] == btBuf[j]) return 0;
  }
  return btN >= 4 ? 1 : 0;
}
static int btZero(void) { return backtrace(btBuf, 0) == 0 ? 1 : 0; }
static int btTwo(void) { bt1(); return backtrace(btBuf, 2) == 2 ? 1 : 0; }

int main(void) {
  /* 1. printf 的旗与长度 */
  printf("[%#x] [%#o] [% d] [%+d] [%05d] [%-5d|]\n", 255, 8, 42, 42, 42, 42);
  printf("[%hhd] [%hd] [%ld] [%lld] [%zu]\n", 300, 70000, 1234567890L, 1234567890123LL,
    (unsigned long)42);
  printf("[%.0f] [%+.0f] [%.0e] [%.1g] [%#.0f]\n", 2.5, 3.5, 12345.0, 0.0001234, 7.0);
  printf("[%*d] [%-*d|] [%.*f]\n", 6, 42, 6, 42, 2, 3.14159);
  printf("[%s] [%.2s] [%c] [%%]\n", "hello", "hello", 'z');
  printf("[%x] [%X] [%o] [%u]\n", 0xdeadbeef, 0xdeadbeef, 511, 4294967295u);

  /* 2. snprintf：回的是「本来要写多少」，装不下也一样；n = 0 时一个字节都不许动 */
  char b[8];
  memset(b, '#', sizeof(b));
  int need = snprintf(b, 8, "%s-%d", "abcdefgh", 12345);
  printf("snprintf need=%d buf=%s\n", need, b);
  int zero = snprintf(b, 0, "xyz");
  printf("snprintf n=0 -> %d 头一个字节还是 %c\n", zero, b[0]);

  /* 3. strtol 一族的边 */
  char *e;
  long v1 = strtol("  -0x1f zz", &e, 0);
  printf("strtol(0x1f, base 0)=%ld 剩下「%s」\n", v1, e);
  long v2 = strtol("99999999999999999999", &e, 10);
  printf("strtol 溢出 -> %ld（该是 LONG_MAX）\n", v2);
  unsigned long v3 = strtoul("-1", &e, 10);
  printf("strtoul(-1)=%lu\n", v3);
  printf("strtol(z, 36)=%ld  strtoll(0b11, 2)=%lld\n",
    strtol("z", (char **)0, 36), strtoll("11", (char **)0, 2));

  /* 4. mem* / str* 的重叠与边界 */
  char s[16];
  memset(s, 0, sizeof(s));
  memmove(s, "abcdef", 7);
  memmove(s + 2, s, 5);                     /* 往后重叠 */
  printf("memmove 重叠 -> %s\n", s);
  char nc[8];
  memset(nc, '@', sizeof(nc));
  strncpy(nc, "ab", 5);                     /* 补零到 5，后面不动 */
  printf("strncpy [%c%c%c%c%c%c]\n", nc[0], nc[1], nc[2], nc[3], nc[4], nc[5]);
  char cat[16] = "ab";
  strncat(cat, "cdef", 2);
  printf("strncat -> %s\n", cat);
  printf("strcmp: %d %d %d\n",
    strcmp("a", "b") < 0, strcmp("\xff", "a") > 0, strncmp("abcx", "abcy", 3));
  printf("strspn=%lu strcspn=%lu strstr=%s strrchr=%s\n",
    strspn("aabbcc", "ab"), strcspn("abcdef", "de"),
    strstr("hello world", "o w"), strrchr("a/b/c", '/'));
  printf("memcmp: %d %d\n", memcmp("abc", "abd", 3) < 0, memcmp("abc", "abc", 3));

  /* 5. qsort / bsearch */
  int arr[9] = { 5, 3, 9, 1, 7, 3, 8, 2, 6 };
  qsort(arr, 9, sizeof(int), cmpInt);
  printf("qsort:");
  for (int i = 0; i < 9; i++) printf(" %d", arr[i]);
  printf("\n");
  int key = 7;
  int *hit = (int *)bsearch(&key, arr, 9, sizeof(int), cmpInt);
  key = 4;
  int *miss = (int *)bsearch(&key, arr, 9, sizeof(int), cmpInt);
  printf("bsearch 找得到 %d、找不到 %d\n", hit != 0 && *hit == 7, miss == 0);

  /* 6. sscanf */
  int a1 = 0;
  unsigned u1 = 0;
  char w1[16];
  char w2[16];
  double d1 = 0.0;
  int got = sscanf("  -12 0x2a hello 3.5e2 rest", "%d %x %s %lf %s", &a1, &u1, w1, &d1, w2);
  printf("sscanf %d: %d %u %s %g %s\n", got, a1, u1, w1, d1, w2);
  int n1 = 0;
  int n2 = 0;
  int got2 = sscanf("7,8", "%d,%d", &n1, &n2);
  printf("sscanf 逗号 %d: %d %d\n", got2, n1, n2);

  /* 7. backtrace（第十八格）。印的是布尔不是地址 —— 地址每次跑都不一样。 */
  printf("backtrace 三层嵌套至少 4 层 %d、地址互不相同 %d、n=0 回 0 %d、装两格回 2 %d\n",
    btDeep(), btDistinct(), btZero(), btTwo());
  return 0;
}
