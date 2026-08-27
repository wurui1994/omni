// 函数值的 **static / autounravel 字段**（第三十八刀）：`static int sf(int) = twice;`。
// 形参表跟在**名字**后面，与文件级那一档（cases/63）是同一条路 —— 类型也走同一个 fnTypeOf。
//
// 量出来的理由：`collections/iter.asy:42` 的
// `autounravel Iterable_T operator cast(T[] items) = Iterable_T;` —— `import plain;`
// 一直卡在那一行上。三条访问路径 asy 全收（量过）：类型名限定、裸名字（autounravel 才有）、
// 实例限定。
//
// struct 别叫 `S`：base 里 `S` 是南那个方向常量（48-static.asy 的注释）。

int twice(int x) {return x * 2;}
int thrice(int x) {return x * 3;}

struct Box {
  static int sf(int) = twice;
  autounravel int af(int) = twice;
  int id = 0;
}

// 类型名限定
write(Box.sf(3));
// 裸名字（autounravel 的那个才有这一条）
write(af(4));
// 实例限定，取的是同一格
Box q;
write(q.af(5));
write(q.sf(6));

// 三个名字里随便哪个写，另外两个都看得见
Box.af = thrice;
write(af(4));
write(q.af(4));
af = twice;
write(Box.af(4));

// typedef 拼的类型也一样
typedef int F(int);
struct Kind {
  static F g = thrice;
  autounravel F h;
  int id = 0;
}
write(Kind.g(2));
write(h == null);
h = twice;
write(h(2));
