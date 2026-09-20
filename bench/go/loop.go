// 纯整数循环：底线（发码与循环形状的账）
package main

func main() {
	s := 0
	for i := 0; i < 200000000; i++ {
		s += i & 1023
	}
	println(s)
}
