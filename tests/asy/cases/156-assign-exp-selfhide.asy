// 一批：赋值当表达式时左边重读不了那一格 / 那一格在自己的初值里还不可见

int calls = 0;
int idx(int i) { ++calls; return i; }

real[] A = new real[6];
for (int i = 0; i < 6; ++i) A[i] = 0;

// 连着赋值，左边的下标里有调用（fin.asy:51 的形状）：下标只求一遍
A[idx(1)] = A[idx(2)] = 1;
write(A);
write(calls);

// 值就是赋进去的那一个
real v = (A[idx(3)] = 2.5);
write(v);
write(A[3]);

// 二维
real[][] B = new real[2][3];
for (int i = 0; i < 2; ++i) for (int j = 0; j < 3; ++j) B[i][j] = 0;
B[idx(0)][idx(1)] = B[idx(1)][idx(2)] = 7;
write(B[0][1]);
write(B[1][2]);

// 自增当表达式，下标里也有调用
int[] C = {10, 20, 30};
write(++C[idx(0)]);
write(C[0]);

// 元素类型的转换走在读回来之前：int 数组收 int
int[] D = new int[2];
D[0] = 0; D[1] = 0;
write(D[idx(0)] = D[idx(1)] = 4);
write(calls);

// 那一格在自己的初值里还不可见：这里的 T 是前面那个 real[]（fin.asy:84 的形状）
real[] T = {1,2,3,4};
real[][] T = {T[0:2], T[2:4], T[0:2]};
write(T[0]);
write(T[2]);
write(T.length);

// 同一句里前面那几个声明子照样可见
real a = 1, b = a + 1;
write(b);

// 里层块里那一格的初值说的也是外层那个
int x = 3;
{
  int x = x + 1;
  write(x);
}
write(x);
