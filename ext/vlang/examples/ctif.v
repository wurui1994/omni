// ext/vlang/examples/ctif.v —— **编译期分支**（`$if`）：走中的摊开、没走的整格丢掉
//
// 期望输出：lin / notwin / both / flagoff。
//
// 账上第二大的一族（V 的 `ctime` 179 + nim 的 `when` 27）。图上一格新节点也没加 ——
// 这一格**根本不该落成运行期的 branch**：没走的那一支不要求编得过（V 与 nim 都明说）。
//
// **环境是"声明"出来的，不是"看这台机器"**（`CT_ENV`）：定死一个参考目标
// （linux · x64 · gcc），跑在哪台机器上都按它算 —— 尺子要可重现。
// 三条规矩，两条来自 V 自己：
//   * `$if 名字`（不带 `?`）—— 名字不在表里就**当场报**（猜一支就少一段或多一段代码）；
//   * `$if 名字 ?` —— V 说这一种"没定义也不报"（树上与错误传播同一个标签
//     `(propagate …)`），所以没声明就是 **false**：那是这门语言自己的默认；
//   * `$if T is $struct` / `$if field.typ is int` —— 要类型才说得清，照旧报。

module main

fn main() {
	$if windows {
		println('win')
	} $else $if linux {
		println('lin')
	} $else {
		println('other')
	}
	$if !windows {
		println('notwin')
	}
	$if x64 && linux {
		println('both')
	}
	$if trace_something ? {
		println('trace')
	} $else {
		println('flagoff')
	}
}
