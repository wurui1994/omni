// ext/cpp/examples/dict.cpp —— 与 go / V / awk / nim / mojo 那几份 dict **同一件事**
//
// 期望输出逐行相同：1 / 3 / 4 / yes。到这儿 map 那四格**九门都有提供者**了 ——
// 而九门的写法一门一个样：
//   * go   ：`map[K]V{…}` 字面量 + comma-ok 问在不在
//   * V    ：同样的字面量 + 一格 `in` 算子
//   * awk  ：没有声明，所有下标都是关联数组
//   * nim  ：`initTable[K, V]()` 造出来 + `hasKey` 方法
//   * mojo ：`Dict[K, V]()` + `in`
//   * cpp  ：**声明就是造**（`std::map<K,V> m;`）+ `count` 在条件里当"在不在"
// 六种记号、六种"问在不在"的写法，落到的是同一格 `map-has`。
//
// **这一份为什么要自己声明 `std::map`**：这一门不做预处理（`#include` 是记号，不展开），
// 所以头文件里那句 `template <class K, class V> class map;` 得由例子写出来 ——
// 写出来之后语法就读得进来（`needs-type` 那台机器只要名字登记过），而 `m` 是不是映射
// 这件事也是从**这一行声明**上认出来的（与 nim 的 `initTable[…]()` 同一条：造它的那一步
// 自带标记，不必回问类型）。头文件真读得进来那一天，这三行删掉、别的一个字不改。

#include <cstdio>

namespace std {
	template <class K, class V> class map;
	class string;
}

int main() {
	std::map<std::string, int> m;
	m["a"] = 1;
	m["b"] = 3;
	printf("%d\n", m["a"]);
	printf("%d\n", m["b"]);
	m["c"] = 4;
	printf("%d\n", m["c"]);
	if (m.count("a")) {
		puts("yes");
	}
	return 0;
}
