// ext/cpp/examples/values.cpp —— 与 CL / nim / V / Scheme / mojo 那几份 values **同一件事**
//
// 期望输出逐行相同：3 / 7。
//
// C++ 的双值载体是 `std::pair`，而图上"一格产生两个值 + 按第几格取用"本来就有：
//   `std::make_pair(3, 7)`  -> values（生产侧）
//   `t.first` / `t.second`  -> pick 0 / pick 1（消费侧）
// 装住整格多值靠 `bind` 的 `keepMulti` 那格附属 —— 与 lua 的 `local t = f()` 是同一格。
//
// 明说边界：`std::pair<int,int>` 当**类型**写出来（形参 / 返回值 / `std::pair<…> t;`）
// 这一批**读不进来** —— 那是语法里"模板名当类型"那笔账，与 `std::vector` / `std::map`
// 欠的是同一笔（所以这份例子把 pair 造在原地，不写它的类型名）。

#include <cstdio>
#include <utility>

int main() {
	auto t = std::make_pair(3, 7);
	printf("%d\n", t.first);
	printf("%d\n", t.second);
	return 0;
}
