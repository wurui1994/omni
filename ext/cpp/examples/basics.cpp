// ext/cpp/examples/basics.cpp —— 第十门语言的第一份例子，与另外九门**同一件事**
//
// 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
//
// cpp 这一份压的是别的九门都没有的两样：
//   * **声明还是表达式**：`printf(...)` 与 `int x = 3;` 在 GLR 下都两解过 ——
//     语法收紧（至多一格 type-spec）+ 一格 prefer（偏表达式）之后才单解，
//     理由与量出来的坑写在 ext/cpp/cpp.grammar 里。
//   * **格式化打印**：`printf("%d\n", x)` 的格式串**不是节点** —— 映射只认
//     `"%d\n"` 与 `"%s\n"` 两种，把它当"打印一格值"收；别的格式串当场报错，不猜。

#include <cstdio>

int sumto(int n) {
	int acc = 0;
	for (int i = 1; i <= n; i++) {
		acc = acc + i;
	}
	return acc;
}

int fact(int n) {
	if (n == 0) {
		return 1;
	}
	return n * fact(n - 1);
}

int max2(int a, int b) {
	if (a > b) {
		return a;
	} else {
		return b;
	}
}

int main() {
	printf("%d\n", sumto(5));
	printf("%d\n", fact(5));
	printf("%d\n", max2(3, 7));
	const char* tag = "ok";
	printf("%s\n", tag);
	return 0;
}
