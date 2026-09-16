// ext/cpp/examples/record.cpp —— 与 go / lua / V / nim 那几份**同一件事**
//
// 期望输出逐行相同：1 / 5 / 6。
// 三格节点各压一行：
//   `Point p = {1, 2};` -> record-new（字段名从 struct 声明来 —— **类型名不进图**）
//   `p.x`               -> field-get
//   `p.y = 5`           -> field-set
//
// cpp 这一份还压出两件别的：
//   * `{1, 2}` 在 C++ 里**既能填记录也能填列表**。分开靠的不是类型系统，是"造它的
//     那一步自带标记" —— 这儿的标记是同一份文件里的 `struct Point`（映射扫一遍就有
//     字段名，`STRUCTS`）。外部头文件里声明的记录扫不到，会当场报错，不猜。
//   * `struct Point { int x; int y; };` 这一行本身**一度解析不出来**：语法里
//     `noptr` 可空（抽象声明符），于是它还能读成"class-spec 当返回类型 + 没名字的
//     声明符 + `{…}` 当函数体"这一格函数定义。抽象声明符只在形参与 type-id 里合法 ——
//     复制一条受限链（`abs-decl`）把那一格挡掉之后才单解。

#include <cstdio>

struct Point {
	int x;
	int y;
};

int main() {
	Point p = {1, 2};
	printf("%d\n", p.x);
	p.y = 5;
	printf("%d\n", p.y);
	printf("%d\n", p.x + p.y);
	return 0;
}
