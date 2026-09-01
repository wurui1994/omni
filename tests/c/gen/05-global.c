/* 第六刀第四片：全局量、`typedef`、`extern`。
 *
 * 全局量住在 data 段里，地址是编译期常量；**没有初始化式的不写一个字节**（线性内存
 * 出生时全是 0，C 也正好规定静态存储期零初始化）。初始化式必须是常量表达式，所以
 * 走的是 `constExpr` 那个独立的小求值器，运行期一条指令都没有。
 *
 * oracle 是 `tcc -B … -run` 的退出码。 */

typedef unsigned char byte;
typedef int V[4];
typedef char *str;

int g = 42;
static long h = 7 * 3;
str msg = "hi";
char *msg2 = "hi";              /* 同一份文本我们共享同一段 data；C 没规定，tcc 不共享，
                                 * 所以**不能**拿 `msg2 == msg` 来比 —— 那一格两边都对 */
byte tab[8];
V vec;
int zero;                       /* 试探性定义：零初始化 */
int neg = -5;
unsigned u32 = 4294967295u;
long long big = 1LL << 40;
short sh = -300;
int sized[sizeof(V) / sizeof(int)];   /* 维度也是常量表达式 */
extern int g;                   /* 重复声明合法，类型必须一致 */

static int sum(int *p, int n) {
  int i;
  int s = 0;
  for (i = 0; i < n; i++) s += p[i];
  return s;
}

/* 全局量取地址：地址是常量，不用影子栈 */
static void addto(int *p, int by) { *p = *p + by; }

int main(void) {
  long s = 0;

  s += g;                       /* 42 */
  s += h;                       /* 21 */
  s += msg[0] + msg[1];         /* 'h' + 'i' = 209 */
  s += msg2[1];                 /* 105 */
  s += sizeof(V);               /* 16 */
  s += sizeof(byte);            /* 1 */
  s += sizeof(str);             /* 8 */
  s += sizeof(sized) / sizeof(int);  /* 4 */
  s += zero;                    /* 0 */
  s += neg;                     /* -5 */
  s += (u32 == 4294967295u);    /* 1 */
  s += big >> 38;               /* 4 */
  s += sh;                      /* -300 */

  /* 写全局量 */
  tab[0] = (byte)200;
  tab[7] = (byte)3;
  s += tab[0] + tab[7];         /* 203 */
  vec[0] = 1; vec[1] = 2; vec[2] = 3; vec[3] = 4;
  s += sum(vec, 4);             /* 10 */
  g = g + 1;
  s += g;                       /* 43 */

  /* 取全局量的地址 */
  addto(&g, 10);
  s += g;                       /* 53 */
  int *p = vec;
  s += *(p + 2);                /* 3 */
  s += &vec[3] - &vec[0];       /* 3 */

  /* 局部量遮蔽全局量 */
  {
    int g = 100;
    s += g;                     /* 100 */
  }
  s += g;                       /* 53 —— 出了块又是全局的那个 */

  /* typedef 名当类型用：强制转换与 sizeof 都认它 */
  s += (byte)(-1);              /* 255 */
  s += (int)(byte)300;          /* 44 */
  {
    V local;
    local[0] = 9;
    s += local[0];              /* 9 */
    s += sizeof(local);         /* 16 */
  }

  return (int)(s % 251);
}
