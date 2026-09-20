package main

func sum(a int, b int) int { return a + b }

func main() {
	n := 0
	for i := 0; i < 10; i++ {
		n = sum(n, i)
	}
	println(n)
}
