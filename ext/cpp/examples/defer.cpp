// ext/cpp/examples/defer.cpp —— 与 go / V / nim / CL / mojo / FB 那六份 defer 例子**同一件事**
//
// 期望输出逐行相同：in / b / a / out。
//
// C++ 没有 `defer`，它的出口动作写在**类**上（RAII）：`~Say()` 一句话说清
// "这个类型的量出了作用域要跑一段"。于是 `Say s1;` 落成
// **一格 bind + 一格 scope-exit** —— 与 go 的 `defer`、FB 的 `Destructor`、
// mojo 的 `__exit__` 是同一格节点。析构体自己是一格普通函数（形参就是 `this`）。
//
// 逆序（后声明的先析构）与"`return` 早退也跑"都是 scope-exit 那一格本来的语义。
// 一个类两个量（靠一格 tag 字段分谁是谁）—— 同名方法要类型才分得开，那笔账
// 明写在映射里，例子不绕过它。
//
// 明说一格：`Say s1;` 的成员在 C++ 里是**未初始化**的（读了是 UB），图上没有"未定"
// 这一格值，映射给 0 —— 这份例子先写后读，所以两家的可观察行为一致。

#include <cstdio>

struct Say {
	int tag;
	~Say() {
		if (this->tag == 1) {
			puts("a");
		} else {
			puts("b");
		}
	}
};

void demo() {
	Say s1;
	Say s2;
	s1.tag = 1;
	s2.tag = 2;
	puts("in");
	return;
}

int main() {
	demo();
	puts("out");
	return 0;
}
