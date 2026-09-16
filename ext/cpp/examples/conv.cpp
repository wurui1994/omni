// ext/cpp/examples/conv.cpp —— 与 go / V / nim / mojo / FB 那几份 conv **同一件事**
//
// 期望输出逐行相同：2 / 3.5。
//
// C++ 这一门与别人不同：**转换在语法上就是转换**（`(int)x` 与 `static_cast<int>(x)`），
// 不是"调用的形状"。所以这儿不需要那张"名字是不是类型"的表 —— 需要的只是
// "目标类型往四格里收"（`int`/`long`/`short`/`char` -> int，`float`/`double` -> float）。
// 两种写法落**同一格 conv 节点**，`to` 是一格附属。
//
// 格式串用 `%g` 而不是 `%f`：真 C 里 `%f` 印的是 `3.500000`，`%g` 印 `3.5` ——
// 图上那格 print 印的是后者，所以例子必须挑对得上的那个（不然就是拿假输出充判据）。

#include <cstdio>

int main() {
	printf("%d\n", (int)(7.0 / 3.0));
	printf("%g\n", static_cast<double>(7) / 2);
	return 0;
}
