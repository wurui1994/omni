// tests/graph/mods/shape.v —— **声明在这儿，用在旁边那份里**（`vshape.v` 导入它）
//
// `Point{3, 4}` 那种位置型字面量要"字段名与顺序"，而它们只写在这份文件里。
// 从前每份文件的映射各扫各的声明，于是导入方当场报"声明不在这一份文件里"——
// 读进来了却看不见。现在一起编的那几份互相看得见声明（`opts.also`）。

struct Point {
	x int
	y int
}

fn area(p Point) int {
	return p.x * p.y
}
