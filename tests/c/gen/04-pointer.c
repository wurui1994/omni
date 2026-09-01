/* 第六刀第三片：指针、数组、影子栈、字符串字面量。
 *
 * oracle 是 `tcc -B .omni-cache/tcc-build -run` 的**退出码**，所以最后一句把累加值
 * 收进一个字节。每一段旁边注的是那一段该加多少 —— 注错了不会让用例变绿（比的是 tcc），
 * 但读的时候能看出这一段在测什么。 */

static int sum3(int *p) { return p[0] + p[1] + p[2]; }

static void bump(int *p, int by) { *p = *p + by; }

static int strlen2(char *s) {
  int n = 0;
  while (*s) { n++; s++; }
  return n;
}

static long swap2(long *a, long *b) {
  long t = *a;
  *a = *b;
  *b = t;
  return *a - *b;
}

/* 递归 + 取地址：每一层的 &acc 必须是自己那一层的 */
static int down(int n) {
  int acc = n;
  int *p = &acc;
  if (n <= 0) return 0;
  *p = acc + down(n - 1);
  return acc;
}

int main(void) {
  long s = 0;

  /* ---- 取地址与解引用 */
  int x = 41;
  int *p = &x;
  s += *p;                        /* 41 */
  *p = 7;
  s += x;                         /* 7：写穿了，p 真的指着 x */
  bump(&x, 5);
  s += x;                         /* 12 */

  /* ---- 指针算术按元素大小缩放 */
  int a[4];
  a[0] = 1; a[1] = 2; a[2] = 4; a[3] = 8;
  s += sum3(a);                   /* 7：数组退化成指针传进去 */
  int *q = a;
  s += *(q + 3);                  /* 8 */
  q = q + 2;
  s += *q;                        /* 4 */
  s += q - a;                     /* 2：两个指针相减要除以元素大小 */
  s += *--q;                      /* 2 */
  s += *q++;                      /* 2：后缀取旧值 */
  s += *q;                        /* 4 */

  /* ---- a[i] 就是 *(a+i)，于是 i[a] 也对 */
  s += 1[a];                      /* 2 */
  s += a[3] - a[0];               /* 7 */

  /* ---- 指针比较与空指针 */
  int *n0 = 0;
  if (n0 == 0) s += 100;
  if (a < a + 1) s += 3;
  if (&a[3] > &a[0]) s += 5;

  /* ---- sizeof：数组是整块，指针是 8 */
  s += sizeof(a);                 /* 16 */
  s += sizeof(p);                 /* 8 */
  s += sizeof(a) / sizeof(a[0]);  /* 4 */
  s += sizeof("abc");             /* 4：含结尾那个 0 */

  /* ---- 二维数组：外层先退化，元素是 int[3] */
  int m[2][3];
  m[0][0] = 1; m[0][1] = 2; m[0][2] = 3;
  m[1][0] = 4; m[1][1] = 5; m[1][2] = 6;
  s += m[1][2];                   /* 6 */
  s += sizeof(m);                 /* 24 */
  s += sizeof(m[0]);              /* 12 */
  int *r = m[1];
  s += r[0] + r[1];               /* 9 */

  /* ---- 字符串字面量在 data 段，退化成 char * */
  char *t = "hello";
  s += strlen2(t);                /* 5 */
  s += t[1];                      /* 'e' = 101 */
  s += *"A";                      /* 65 */
  s += "abc"[2];                  /* 'c' = 99 */

  /* ---- 窄类型经内存往返：符号性要保住 */
  char cbuf[4];
  cbuf[0] = 'a';
  cbuf[1] = (char)200;            /* char 有符号：-56 */
  cbuf[2] = 0;
  s += cbuf[0];                   /* 97 */
  s += cbuf[1];                   /* -56 */
  s += strlen2(cbuf);             /* 2 */

  unsigned char ubuf[2];
  ubuf[0] = (unsigned char)200;
  ubuf[1] = 0;
  s += ubuf[0];                   /* 200 */

  short sbuf[2];
  sbuf[0] = (short)-3;
  sbuf[1] = (short)70000;         /* 收进 16 位：4464 */
  s += sbuf[0] + sbuf[1];

  /* ---- 影子栈：两个地址传出去、在被调用者里互换 */
  long u = 3;
  long v = 9;
  s += swap2(&u, &v);             /* 9 - 3 = 6 */
  s += u * 10 + v;                /* 93 */
  s += down(4);                   /* 4+3+2+1 = 10 */

  /* ---- 循环里取地址：平铺的帧让地址每轮都一样 */
  int i;
  int acc = 0;
  for (i = 0; i < 5; i++) {
    int k = i * i;
    int *kp = &k;
    acc += *kp;
  }
  s += acc;                       /* 0+1+4+9+16 = 30 */

  /* ---- 条件表达式的两支是指针 */
  int *sel = (x > 0) ? &a[0] : &a[3];
  s += *sel;                      /* 1 */

  /* ---- 指针经 _Bool 与整数往返 */
  if (p) s += 11;
  if (!n0) s += 13;

  return (int)(s % 251);
}
