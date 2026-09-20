package main

type Texture interface{ At(x int) int }

type Solid struct{ K int }

func (s *Solid) At(x int) int { return s.K * x }

func main() {
	m := map[string]Texture{}
	m["a"] = &Solid{K: 3}
	m["b"] = &Solid{K: 5}
	t := m["a"]
	println(t.At(2))
	u, ok := m["b"]
	if ok {
		println(u.At(4))
	}
	if m["zz"] == nil {
		println("miss")
	}
}
