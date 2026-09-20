// 调用密集：递归 fib（内联与调用约定的账）
package main

func fib(n int) int {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func main() { println(fib(32)) }
