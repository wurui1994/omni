// ext/go/examples/ptrmethod.go —— **指针接收者**（go 独一份）
//
// 期望输出（六条腿逐行相同）：1 / 5 / 5。
//
// 为什么单开一族：go 里**大多数**方法的接收者是 `*T` 而不是 `T`，而这一格从前登记错了 ——
// 声明那一处剥掉指针发出 `Counter__get`，登记那一处只认光秃秃的 `(tname …)` 于是把主人
// 记成 `'?'`，调用点落一格 `ref ?__get`：**指向不存在的函数**。图落得出来、尺子数得上，
// 跑起来才炸。两处现在共用 `recvOwner`（`ext/go/tograph.js`），这一份就是它的判据。
//
// 第三行是**改**那一半的判据：`c.add(4)` 之后 `c.n` 要是 5。图上"接收者只是第一格实参"，
// 而记录在六条腿上都是**按引用**传的 —— 所以指针接收者里的 `c.n = …` 看得见。
// （真别名那一族 —— `&x` 取标量的地址、光秃秃的 `*p` 当值用 —— 仍旧当场报，不在这一份里。）

package main

import "fmt"

type Counter struct {
	n int
}

func (c *Counter) get() int {
	return c.n
}

func (c *Counter) add(k int) {
	c.n = c.n + k
}

func main() {
	c := Counter{n: 1}
	fmt.Println(c.get())
	c.add(4)
	fmt.Println(c.get())
	fmt.Println(c.n)
}
