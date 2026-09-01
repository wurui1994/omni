/* 第六刀第二十四片：`goto` 跳到哪儿都行。
 *
 * 第十片只做到「标签直接长在某个复合语句的语句层上，而且 goto 在那个块里面」。这一片
 * 把状态机收成**函数一台**，再让每层语句各出一小段（跳过头、进对的那一半），于是
 * 「跳进兄弟块」「跳进循环体」「标签长在 if 里」一起有了。
 *
 * 每一形都算得死死的，没有一处依赖未初始化的量。 */

int printf(const char *fmt, ...);

/* 1. 往回跳 —— tinycc 自己满地都是的 `goto redo;` */
static int redoLoop(int n) {
  int k = 0;
redo:
  k++;
  n--;
  if (n > 0) goto redo;
  return k;
}

/* 2. 跳进一个 for 的循环体：标签在兄弟块里，而且初始化式与测条件都要跳过。
 *    i 进去时是 7，所以 s = 7；步进之后 8 < 3 假，一圈就出来。 */
static int intoFor(void) {
  int i = 7;
  int s = 0;
  goto inner;
  for (i = 0; i < 3; i++) {
  inner:
    s += i;
  }
  return s * 10 + i;
}

/* 3. 标签长在 `if` 里（Duff's device 那一形）：重新进入时不能重算条件，
 *    得直接进 then 那一半。 */
static int inIf(int n) {
  int i = 0;
  if (n > 0) half: i += 2;
  if (i == 2) { n = 0; goto half; }
  return i;
}

/* 4. 从两层循环里一跳到底 —— `goto out;` 那一形。循环变量是槽，跳出去照旧看得见。 */
static int breakOut(void) {
  int i, j, hits = 0;
  for (i = 0; i < 4; i++) {
    for (j = 0; j < 4; j++) {
      hits++;
      if (i * j > 3) goto out;
    }
  }
out:
  return hits * 100 + i * 10 + j;
}

/* 5. 跳进一个 while 的循环体，落在循环体那个块的中间，然后照常绕圈。 */
static int intoWhile(void) {
  int n = 0, t = 0;
  goto mid;
  while (n < 3) {
    t += 1;
  mid:
    t += 10;
    n++;
  }
  return t;
}

/* 6. 同一层两个标签，往前往后都跳。 */
static int twoLabels(int x) {
  int r = 0;
a:
  r += 1;
  if (x == 1) { x = 2; goto b; }
  r += 100;
b:
  r += 10000;
  if (x == 2) { x = 3; goto a; }
  return r;
}

/* 7. 跳进套了两层的普通块。 */
static int intoBlock(void) {
  int v = 1;
  goto deep;
  {
    v += 2;
    {
      v += 4;
    deep:
      v += 8;
    }
    v += 16;
  }
  return v;
}

/* 8. 标签在函数最后，后面只有一个空语句；顺着掉下来与跳过来是同一条路。 */
static int fallThrough(int x) {
  int v = 0;
  if (x) goto done;
  v = 5;
done:
  ;
  return v + 1;
}

/* 9. do-while 的循环体里有标签：循环体就在最前面，什么都不用跳过。 */
static int inDo(void) {
  int n = 0, t = 0;
  goto body;
  do {
    t += 1;
  body:
    t += 100;
    n++;
  } while (n < 2);
  return t;
}

int main(void) {
  printf("redo %d %d\n", redoLoop(1), redoLoop(5));
  printf("for %d\n", intoFor());
  printf("if %d %d\n", inIf(1), inIf(0));
  printf("out %d\n", breakOut());
  printf("while %d\n", intoWhile());
  printf("two %d %d\n", twoLabels(1), twoLabels(0));
  printf("block %d\n", intoBlock());
  printf("fall %d %d\n", fallThrough(1), fallThrough(0));
  printf("do %d\n", inDo());
  return intoFor() + inIf(1) % 10 + intoBlock() % 10;
}
