/* 第八刀第五十三片：语句表达式里带标签。
 *
 * 里面有标签的复合语句要开一层 MIR block 摆分派链，而块里定义的 ref 出了块就不能用 ——
 * 所以这一种的值得落在槽上。而且这台状态机是**语句表达式自己的**：gcc 禁止跳进语句
 * 表达式，所以里面的 goto 只可能是里面的事。 */
#include <stdio.h>

struct S { int a, b, c; };

static int side;

static int bump(int n) { side += n; return n; }

int main(void) {
  /* 1. 最朴素的：标签在前，值在后 */
  int s = 0;
  int v = ({ lab1: s = s + 7; s; });
  printf("v %d %d\n", v, s);

  /* 2. 往后跳：goto 跳过中间那条，值还是最后一条 */
  int w = ({ __label__ l1; s = 1; goto l1; s = 100; l1: s + 2; });
  printf("w %d %d\n", w, s);

  /* 3. 往前跳：语句表达式里跑一圈循环 */
  int acc = 0, i = 0;
  int r = ({ top: acc = acc + i; i++; if (i < 5) goto top; acc; });
  printf("r %d %d %d\n", r, acc, i);

  /* 4. 值是聚合：落在槽上的是地址，出了块照样能读 */
  struct S st = { 1, 2, 3 };
  struct S q = ({ ls: st.b = 20; st; });
  printf("q %d %d %d\n", q.a, q.b, q.c);

  /* 5. 嵌套：里外各一台状态机，各跳各的 */
  int n = ({ __label__ o; int x = ({ __label__ k; int y = 3; goto k; y = 9; k: y + 1; });
             if (x == 4) goto o; x = 0; o: x * 10; });
  printf("n %d\n", n);

  /* 6. 一条表达式语句都没有 -> void，只当语句用 */
  ({ __label__ e; side = 0; bump(5); goto e; bump(100); e:; });
  printf("side %d\n", side);

  /* 7. 类型不一样的几条：只有最后那条算 */
  double d = ({ lz: (void)bump(1); 1; 2.5; });
  printf("d %.1f %d\n", d, side);

  /* 8. 长在循环里：每一圈都重新进那台状态机 */
  int sum = 0;
  for (int j = 0; j < 4; j++) sum += ({ __label__ c; int t = j; if (t == 2) goto c; t = t * 10; c: t + 1; });
  printf("sum %d\n", sum);

  /* 9. 里面有 switch，与状态机同居 */
  int m = 0;
  int z = ({ __label__ sk; switch (s) { case 3: m = 30; goto sk; case 4: m = 40; break; default: m = -1; }
             m = m + 1; sk: m + 2; });
  printf("z %d %d %d\n", z, m, s);

  /* 10. 里面有变长数组：$sp 切出来的那块与状态机不打架 */
  int k = 6;
  int p = ({ __label__ vv; int a[k]; a[0] = 11; if (a[0] == 11) goto vv; a[0] = 0; vv: a[0] + (int)sizeof(a); });
  printf("p %d\n", p);

  /* 11. 语句表达式当条件用 */
  if (({ cc: s > 0; })) printf("cc yes %d\n", s);

  /* 13. 标签紧贴着 case / default（tccpp.c 的 `_default: default:` 那种写法）：
   *     深度上标签**不能**是透明的，不然 `default:` 就被算成 switch 的直接子语句了 */
  int g = 0;
  for (int j = 0; j < 4; j++) {
    switch (j) {
      case 0: g += 1; break;
      lc: case 1: g += 10; break;
      _d: default: g += 100; if (j == 3) goto lc; break;
    }
  }
  printf("g %d\n", g);

  /* 12. return 里的那一种 */
  return ({ __label__ rr; int rv = 0; goto rr; rv = 3; rr: rv; });
}
