/* 第六刀：整型的宽度、符号、提升与转换。
 * 每一格算完收进 s，最后 `% 251` —— 退出状态只有 8 位（wait(2) 的规矩），取素数模是
 * 为了少一点"两个错互相抵消刚好落回同一个字节"的机会。 */

/* 窄类型的返回值要在 return 那里收口 */
char clip(int v) { return v; }
unsigned char uclip(int v) { return v; }
short shret(int v) { return v; }
long long widen(int v) { return v; }

/* 有原型时是**调用方**把实参转成声明的类型，形参不做实参提升 */
int takes_char(char c) { return c; }
int takes_uchar(unsigned char c) { return c; }
int takes_ll(long long v) { return v == -1; }

int main(void) {
  int s = 0;

  /* ---- sizeof。LP64：long 与 long long 都是 8 */
  s += sizeof(char) + sizeof(short) + sizeof(int) + sizeof(long) + sizeof(long long);
  s += sizeof(_Bool) + sizeof(unsigned) + sizeof(signed char);
  s += sizeof('a');            /* 'a' 在 C 里是 int，所以 4 —— 不是 1 */
  s += sizeof(1) + sizeof(1L) + sizeof(1u) + sizeof(1ULL);
  int dummy = 3;
  s += sizeof dummy;           /* 不带括号的 sizeof 表达式 */
  s += sizeof(dummy + 1L);     /* 常规算术转换之后是 long -> 8 */

  /* ---- 说明符可以乱序 */
  unsigned long int ul1 = 5;
  long unsigned ul2 = 5;
  int unsigned iu = 5;
  long long int lli = 5;
  s += (ul1 == ul2) + (iu == 5) + (lli == 5);

  /* ---- char 的截断与符号（本机的 char 是有符号的） */
  char c = 200;                /* 收口成 -56 */
  s += (c < 0);
  s += (c == -56);
  signed char sc = -1;
  s += (sc == -1);
  unsigned char uc = 200;
  s += (uc == 200);
  uc = uc + 100;               /* 300 收口成 44 */
  s += uc;

  /* ---- short */
  short sh = 40000;            /* 收口成 -25536 */
  s += (sh < 0) + (sh == -25536);
  unsigned short ush = 40000;
  s += (ush == 40000);
  ush = ush * 2;               /* 80000 收口成 14464 */
  s += (ush == 14464);

  /* ---- 整型提升：char + char 在 int 里算，不在 char 里算 */
  char a1 = 100;
  char b1 = 100;
  s += ((a1 + b1) == 200);     /* 不是 -56 */
  s += (sizeof(a1 + b1) == 4); /* 提升之后是 int */
  s += (-c == 56);             /* 一元负号也先提升 */
  s += (sizeof(-c) == 4);
  s += ((unsigned char)200 >> 1 == 100);  /* 提升成 int 之后是算术右移 */

  /* ---- 无符号比较：常规算术转换把 -1 变成最大值 */
  s += (-1 > 0u);
  s += (-1 < 1);
  s += ((long long)-1 < 1u);   /* long long 装得下全部 uint，所以按有符号比 */

  /* ---- 有符号除法向零取整；无符号是另一套算子 */
  int sd = -7;
  s += (sd / 2 == -3) + (sd % 2 == -1);
  unsigned ud = 4294967295u;
  s += (ud / 1000000000u);     /* 4 */
  s += (ud % 7u);              /* 3 */
  s += (ud > 1000);

  /* ---- 右移：有符号算术、无符号逻辑 */
  int neg = -16;
  s += (neg >> 2 == -4);
  unsigned un = 4294967280u;   /* 0xfffffff0 */
  s += ((un >> 28) == 15);
  s += ((int)un >> 28 == -1);  /* 同样的位，有符号读法 */
  s += (1 << 4);

  /* ---- long long */
  long long ll = 1;
  ll = ll << 40;
  s += (ll == 1099511627776LL);
  s += ((int)(ll >> 40));
  unsigned long long ull = 18446744073709551615ULL;
  s += (ull > 0);
  s += (ull / 1000000000000000000ULL);          /* 18 */
  s += ((long long)ull == -1);
  s += (ull / 2 == 9223372036854775807ULL);     /* 无符号除 */
  s += ((long long)-1 / 2 == 0);                /* 有符号除 */

  /* ---- 显式转换：扩宽看源的符号性，变窄回绕 */
  s += ((long long)(unsigned)-1 == 4294967295LL);
  s += ((long long)(int)-1 == -1);
  s += ((int)1234605616436508552LL == 305419896);
  s += ((char)511 == -1);
  s += ((unsigned char)511 == 255);
  s += ((short)65535 == -1);
  s += ((unsigned short)-1 == 65535);

  /* ---- _Bool：非零就是 1，不是截低位 */
  _Bool bo = 256;
  s += bo;
  s += ((_Bool)2 == 1);
  _Bool bz = 0;
  s += !bz;

  /* ---- 三元的两支走常规算术转换 */
  s += (sizeof(1 ? 1 : 1LL) == 8);
  s += ((1 ? -1 : 0u) == 4294967295u);
  s += (0 ? 7 : 9);

  /* ---- 复合赋值在收口之后 */
  char cc = 100;
  cc += 100;                   /* 200 收口成 -56 */
  s += (cc == -56);
  unsigned char ucc = 250;
  ucc += 10;                   /* 260 收口成 4 */
  s += ucc;

  /* ---- 前后缀在窄类型上也收口 */
  char inc = 127;
  inc++;                       /* 收口成 -128 */
  s += (inc == -128);
  unsigned char uinc = 255;
  uinc++;
  s += (uinc == 0);

  /* ---- 窄返回值与实参转换 */
  s += (clip(300) == 44) + (uclip(300) == 44);
  s += (shret(70000) == 4464);
  s += (widen(-1) == -1);
  s += (takes_char(300) == 44);
  s += (takes_uchar(300) == 44);
  s += takes_ll(-1);

  return s % 251;
}
