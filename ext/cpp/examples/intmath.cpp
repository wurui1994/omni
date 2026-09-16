// ext/cpp/examples/intmath.cpp —— 与另外九门的 intmath.* **同一件事**
//
// 期望输出逐行相同：15 / 120。
// 刻意贫瘠：只有整数 / 函数 / if / while —— 这是四条腿（含 wasm）都接得住的子集。

#include <cstdio>

int sumto(int n) {
	int acc = 0;
	int i = 1;
	while (i <= n) {
		acc = acc + i;
		i++;
	}
	return acc;
}

int fact(int n) {
	if (n == 0) {
		return 1;
	}
	return n * fact(n - 1);
}

int main() {
	printf("%d\n", sumto(5));
	printf("%d\n", fact(5));
	return 0;
}
