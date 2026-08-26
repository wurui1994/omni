// 控制流。核心方言没有 do-while，也没有 for 的三段头，都在前端摊开；
// 摊开之后 continue 必须先跑更新段，这条最容易错，所以下面第三个循环专门钉它。
int i;
for (i = 0; i < 5; ++i) write(i);
write("after i = ", i);

int sum = 0;
for (int j = 1; j <= 10; ++j) {
  if (j % 2 == 0) continue;
  if (j > 7) break;
  sum += j;
}
write(sum);

int k = 0, n = 0;
while (k < 100) {
  ++k;
  if (k % 3 != 0) continue;
  n += k;
  if (n > 30) break;
}
write(k, n);

int d = 0;
do {
  ++d;
} while (d < 4);
write(d);

int e = 10;
do ++e; while (false);
write(e);

// 嵌套：break 只跳出内层
int hits = 0;
for (int a = 0; a < 3; ++a) {
  for (int b = 0; b < 3; ++b) {
    if (b == 1) break;
    ++hits;
  }
}
write(hits);

// if / else if / else
for (int t = -1; t <= 1; ++t) {
  if (t < 0) write("neg");
  else if (t == 0) write("zero");
  else write("pos");
}

// 空更新段与空条件段的组合（asy 允许 for(;;) 配 break）
int z = 0;
for (;;) {
  ++z;
  if (z == 3) break;
}
write(z);

// 逗号更新段
int p = 0, q = 10;
for (int m = 0; m < 3; ++m, --q) p += q;
write(p, q);

// 三元式：核心方言里 `?:` 只有语句形态，所以这一层摊成临时量 + if/else
for (int t = 0; t < 4; ++t) write(t % 2 == 0 ? "even" : "odd");
int big = p > q ? p : q;
write(big);
write(p > q ? p : q > 0 ? q : 0);
