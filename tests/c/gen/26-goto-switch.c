/* 第六刀第二十五片：语句标签长在 `switch` 里。
 *
 * case 的段界与语句标签的段界摆在**同一串嵌套 `BLOCK`** 上，两台分派都由函数体那一层
 * 发（`openSegs`）：状态非 0 就按区间送到带标签的那条子语句，状态 0 才轮到 case 那台。
 * 选择子落在一个槽上，而且被重新进入时整段求值都跳过。 */

int printf(const char *fmt, ...);

/* 1. 从 switch 外面跳进一个 case 里的标签（选择子一次都不算）。 */
static int intoCase(int x) {
  int r = 0;
  if (x == 9) goto inner;
  switch (x) {
  case 0:
    r += 1;
  inner:
    r += 10;
    break;
  case 1:
    r += 100;
    break;
  default:
    r += 1000;
  }
  return r;
}

/* 2. 从 switch 里往回跳到 switch 之前的标签 —— 选择子每一圈都要重新算。 */
static int backOut(void) {
  int n = 0, log = 0;
again:
  n++;
  switch (n) {
  case 1:
    log += 1;
    goto again;
  case 2:
    log += 20;
    goto again;
  default:
    log += 300;
  }
  return log;
}

/* 3. 贯穿还在：标签夹在两个 case 之间，落进去之后一路往下贯穿。 */
static int fall(int x) {
  int r = 0;
  switch (x) {
  case 0:
    r += 1;
  mid:
    r += 2;
  case 1:
    r += 4;
  case 2:
    r += 8;
    break;
  case 3:
    r += 16;
    goto mid;
  }
  return r;
}

/* 4. switch 在循环里，`goto` 一跳出两层。 */
static int outOfLoop(void) {
  int i, acc = 0;
  for (i = 0; i < 10; i++) {
    switch (i) {
    case 3:
      acc += 100;
      goto done;
    default:
      acc += 1;
    }
  }
done:
  return acc * 10 + i;
}

/* 5. 里层 switch 里的标签，从最外面跳进去 —— 分派链一层一层往里接。 */
static int nested(int x) {
  int r = 0;
  if (x) goto deep;
  switch (x) {
  case 0:
    switch (x + 1) {
    case 1:
      r += 5;
    deep:
      r += 50;
      break;
    }
    r += 500;
    break;
  }
  return r;
}

/* 6. 标签长在 `default` 里。 */
static int inDefault(int x) {
  int r = 0;
  switch (x) {
  case 0:
    r += 1;
    break;
  default:
  d:
    r += 7;
    break;
  }
  if (r == 7 && x == 5) { x = 0; goto d; }
  return r;
}

int main(void) {
  printf("into %d %d %d %d\n", intoCase(0), intoCase(9), intoCase(1), intoCase(5));
  printf("back %d\n", backOut());
  printf("fall %d %d %d %d %d\n", fall(0), fall(1), fall(2), fall(3), fall(7));
  printf("loop %d\n", outOfLoop());
  printf("nest %d %d\n", nested(0), nested(1));
  printf("def %d %d\n", inDefault(0), inDefault(5));
  return intoCase(9) + fall(3) + inDefault(5) % 10;
}
