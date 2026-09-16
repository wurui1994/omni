// ext/cpp/examples/loopexit.cpp —— 与 go / lua / V / nim / mojo 那几份**同一件事**
//
// 期望输出逐行相同：12 / 6 / 8。
// 第二个循环压的是**continue 与步进的关系**：`j++` 落在 `loop` 的 `post` 端口上，
// `continue` 跳过体的剩下部分却**照跑步进** —— 缀在体末尾的写法在这儿会死循环。
//
// cpp 进这一族一行新节点都没加：`break` / `continue` 落的就是 go 那两格 `loop-exit`
// （同一格节点，差一格附属 `kind`）。`while (1)` 与 `for (;;)` 也是同一格 `loop`。

#include <cstdio>

int main() {
	int s = 0;
	int i = 0;
	while (1) {
		i = i + 1;
		if (i > 5) {
			break;
		}
		if (i == 3) {
			continue;
		}
		s = s + i;
	}
	printf("%d\n", s);
	printf("%d\n", i);

	int t = 0;
	for (int j = 0; j < 5; j++) {
		if (j == 2) {
			continue;
		}
		t = t + j;
	}
	printf("%d\n", t);
	return 0;
}
