// 第四十五刀：算符名是**普通名字**——任意元数、能当模块级变量的名字、能直呼；
// 以及匿名函数的类型里要留住那一格 `...`。
using interp = int(... int[]);

int operator +(int a, int b, int c) { return a + b + c; }

struct TS { real out; real in; bool atLeast; }

TS operator tension(real tout, real tin, bool atLeast) {
  TS t;
  t.out = tout;
  t.in = tin;
  t.atLeast = atLeast;
  return t;
}

TS operator tension(real t, bool atLeast) { return operator tension(t, t, atLeast); }

interp operator ..(TS t) {
  return new int(... int[] a) { return a.length + (int) t.out; };
}

interp operator :: = operator ..(operator tension(1, true));
interp operator --- = operator ..(operator tension(4, false));

int twice(int x) { return 2 * x; }

int apply(int x, int f(int)) { return f(x); }

// 形参名也可以是算符名（第四十四刀），这里连着任意元数一起用
int sum3(int a, int b, int c, int operator +(int, int, int)) {
  return operator +(a, b, c);
}

void main() {
  write(operator +(1, 2, 3));
  write(1 + 2);
  TS t = operator tension(2, 5, true);
  write(t.out);
  write(t.in);
  write(t.atLeast);
  TS u = operator tension(3, false);
  write(u.out);
  write(u.atLeast);
  write(operator ::(7, 8));
  write(operator ---(7, 8, 9));
  write(apply(5, twice));
  write(sum3(1, 2, 3, operator +));
  interp f = operator ..(operator tension(10, 10, false));
  write(f(1, 2, 3, 4));
}

main();
