// ext/cpp/examples/index.cpp —— 与 go / lua / V / nim / 两门 Lisp / mojo 那几份**同一件事**
//
// 期望输出逐行相同：10 / 30 / 45。
// C++ 的下标与 go 一样从 0 起（lua 从 1 起，那份的映射自己摆平）—— 落到的图同形。
//
// cpp 进这一族也没加节点：`int xs[3] = {10, 20, 30};` 落 `list-new` + `bind`，
// `xs[i]` 落 `index-get`，`xs[1] = 5` 落 `index-set`。数组的长度（`[3]`）图上没有格子 ——
// 它是类型的事，而类型全丢。

#include <cstdio>

int main() {
	int xs[3] = {10, 20, 30};
	printf("%d\n", xs[0]);
	printf("%d\n", xs[2]);
	xs[1] = 5;
	int s = 0;
	for (int i = 0; i < 3; i++) {
		s = s + xs[i];
	}
	printf("%d\n", s);
	return 0;
}
