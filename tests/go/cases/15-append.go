package main

import "fmt"

type Tri struct {
	V1 float64
}

type Mesh struct {
	Triangles []Tri
}

func main() {
	xs := []float64{}
	xs = append(xs, 1)
	xs = append(xs, 2.5, 3.5)
	t := 0.0
	for _, v := range xs {
		t += v
	}
	fmt.Println(t)
	fmt.Println(len(xs))
	m := Mesh{}
	m.Triangles = append(m.Triangles, Tri{7})
	fmt.Println(m.Triangles[0].V1)
}
