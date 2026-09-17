// ext/vlang/examples/ctconst.v —— **`@FN` 那一族："我在谁里头"落一格常量串**（V 独一份）
//
// 期望输出：who / demo / Box / Box.label / main。
//
// `编译期求值` 是账上第二大的一族，而它里头**有一半根本不用求值**：`@FN` / `@METHOD` /
// `@STRUCT` / `@MOD` 问的是"我在谁里头"，答案就在这棵树上（当前函数 · 接收者的类型 ·
// 模块名）—— 落一格 const 串是**准确的**，不是猜。
//
// 另一半当场报，两条各有理由：
//   * `@FILE` / `@LINE` / `@DIR` / `@LOCATION` —— 位置信息，这一层的树上**没有行号**；
//   * `@VEXE` / `@VEXEROOT` / `@VMODROOT` / `@VROOT` / `@OS` / `@CCOMPILER` ——
//     **编译那台机器**上的路径与目标平台，这一层不知道。编个串上去就是静默的错答案。
//
// 这一份**故意不从函数里返回串**：wasm 那条腿的返回值上还接不住字符串（它在线性内存里是
// 一块地址，要类型层才认得出）—— 那条账早就有名有姓，判据不必再撞一遍。
// 顺带说一句：`return @STRUCT + '.' + @FN` 那种写法把 core 那条腿撞出过一个真 bug ——
// 串接在 V 里也写成 `+`，而"函数返回一格 `+`"原来一律被说成返回 int（见 backend-core.js
// 的 `litLeaningType`）。

module demo

struct Box {
	n int
}

fn (b Box) label() {
	println(@STRUCT)
	println(@METHOD)
}

fn who() {
	println(@FN)
	println(@MOD)
}

fn main() {
	who()
	b := Box{n: 1}
	b.label()
	println(@FN)
}
