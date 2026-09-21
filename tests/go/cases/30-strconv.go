//omni:pkgs src/lib/go/strconv,src/lib/go/strings
// `strconv` 那份桩：ParseInt（含 base 0 的前缀判定）/ ParseFloat（含指数）/ Atoi / Itoa。
package main

import "strconv"

func main() {
	a, _ := strconv.ParseInt("123", 0, 0)
	println(a)
	b, _ := strconv.ParseInt("-0x1f", 0, 0)
	println(b)
	c, _ := strconv.ParseInt("0755", 0, 0)
	println(c)
	d, _ := strconv.ParseInt("101", 2, 0)
	println(d)
	e, _ := strconv.ParseFloat("3.25", 64)
	println(int(e * 100))
	g, _ := strconv.ParseFloat("-1.5e2", 64)
	println(int(g))
	h, _ := strconv.ParseFloat("0.001", 64)
	println(int(h * 100000))
	i, _ := strconv.Atoi("-42")
	println(i)
	println(strconv.Itoa(-407))
	println(strconv.Itoa(0))
}
