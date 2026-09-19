// smallpt 的 Go 版本 — 与 lua/js/c 三份同一个算法、同一个 LCG、同样的运算次序。
// 校验和必须与其他四份一致。
// 用法: go run bench/ir/suite/extreme/smallpt.go
package main

import (
	"fmt"
	"math"
)

const (
	W     = 48
	H     = 48
	SAMPS = 1
	ITERS = 1
)

var gSeed uint32 = 0

func rnd() float64 {
	gSeed = 214013*gSeed + 2531011
	return float64(gSeed) * (1.0 / 4294967296.0)
}

type Vec struct{ X, Y, Z float64 }

func V(x, y, z float64) Vec    { return Vec{x, y, z} }
func vadd(a, b Vec) Vec         { return Vec{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func vsub(a, b Vec) Vec         { return Vec{a.X - b.X, a.Y - b.Y, a.Z - b.Z} }
func vmul(a Vec, b float64) Vec { return Vec{a.X * b, a.Y * b, a.Z * b} }
func vmult(a, b Vec) Vec        { return Vec{a.X * b.X, a.Y * b.Y, a.Z * b.Z} }
func vdot(a, b Vec) float64     { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }
func vnorm(a Vec) Vec            { return vmul(a, 1.0/math.Sqrt(a.X*a.X+a.Y*a.Y+a.Z*a.Z)) }
func vcross(a, b Vec) Vec {
	return Vec{a.Y*b.Z - a.Z*b.Y, a.Z*b.X - a.X*b.Z, a.X*b.Y - a.Y*b.X}
}

var Zero = Vec{0, 0, 0}
var XAxis = Vec{1, 0, 0}
var YAxis = Vec{0, 1, 0}

const (
	DIFF = 0
	SPEC = 1
	REFR = 2
)

type Ray struct{ O, D Vec }
type Sphere struct {
	Rad, SqRad, MaxC float64
	P, E, C, CC      Vec
	Refl              int
}

var spheres [9]Sphere

func mk(i int, rad float64, p, e, c Vec, refl int) {
	s := &spheres[i]
	s.Rad = rad; s.P = p; s.E = e; s.C = c; s.Refl = refl
	s.SqRad = rad * rad
	m := c.X; if c.Y > m { m = c.Y }; if c.Z > m { m = c.Z }
	s.MaxC = m
	s.CC = vmul(c, 1.0/s.MaxC)
}

func scene() {
	mk(0, 1e5, V(1e5+1, 40.8, 81.6), Zero, V(.75, .25, .25), DIFF)
	mk(1, 1e5, V(-1e5+99, 40.8, 81.6), Zero, V(.25, .25, .75), DIFF)
	mk(2, 1e5, V(50, 40.8, 1e5), Zero, V(.75, .75, .75), DIFF)
	mk(3, 1e5, V(50, 40.8, -1e5+170), Zero, Zero, DIFF)
	mk(4, 1e5, V(50, 1e5, 81.6), Zero, V(.75, .75, .75), DIFF)
	mk(5, 1e5, V(50, -1e5+81.6, 81.6), Zero, V(.75, .75, .75), DIFF)
	mk(6, 16.5, V(27, 16.5, 47), Zero, vmul(V(1, 1, 1), .999), SPEC)
	mk(7, 16.5, V(73, 16.5, 78), Zero, vmul(V(1, 1, 1), .999), REFR)
	mk(8, 600, V(50, 681.6-.27, 81.6), V(12, 12, 12), Zero, DIFF)
}

func sphIntersect(s *Sphere, r Ray) float64 {
	op := vsub(s.P, r.O)
	b := vdot(op, r.D)
	det := b*b - vdot(op, op) + s.SqRad
	eps := 1e-4
	if det < 0 { return 0 }
	dets := math.Sqrt(det)
	if b-dets > eps { return b - dets }
	if b+dets > eps { return b + dets }
	return 0
}

func intersect(r Ray) (*Sphere, float64) {
	t := 1e20
	var obj *Sphere
	for i := range spheres {
		d := sphIntersect(&spheres[i], r)
		if d != 0 && d < t { t = d; obj = &spheres[i] }
	}
	return obj, t
}

func radiance(r Ray, depth int) Vec {
	obj, t := intersect(r)
	if obj == nil { return Zero }

	newDepth := depth + 1
	isMaxDepth := newDepth > 100
	isUseRR := newDepth > 5
	isRR := isUseRR && rnd() < obj.MaxC

	if isMaxDepth || (isUseRR && !isRR) { return obj.E }

	f := obj.C
	if isUseRR && isRR { f = obj.CC }
	x := vadd(r.O, vmul(r.D, t))
	n := vnorm(vsub(x, obj.P))
	nl := n
	if vdot(n, r.D) >= 0 { nl = vmul(n, -1) }

	if obj.Refl == DIFF {
		r1 := 2 * math.Pi * rnd()
		r2 := rnd()
		r2s := math.Sqrt(r2)
		w := nl
		wo := YAxis; if math.Abs(w.X) > .1 { wo = YAxis } else { wo = XAxis }
		u := vnorm(vcross(wo, w))
		v := vcross(w, u)
		d := vnorm(vadd(vadd(vmul(vmul(u, math.Cos(r1)), r2s), vmul(vmul(v, math.Sin(r1)), r2s)), vmul(w, math.Sqrt(1-r2))))
		return vadd(obj.E, vmult(f, radiance(Ray{x, d}, newDepth)))
	} else if obj.Refl == SPEC {
		return vadd(obj.E, vmult(f, radiance(Ray{x, vsub(r.D, vmul(vmul(n, 2), vdot(n, r.D)))}, newDepth)))
	} else {
		reflRay := Ray{x, vsub(r.D, vmul(n, 2*vdot(n, r.D)))}
		into := vdot(n, nl) > 0
		nc := 1.0; nt := 1.5
		nnt := nc / nt; if !into { nnt = nt / nc }
		ddn := vdot(r.D, nl)
		cos2t := 1 - nnt*nnt*(1-ddn*ddn)
		if cos2t < 0 { return vadd(obj.E, vmult(f, radiance(reflRay, newDepth))) }
		sign := 1.0; if !into { sign = -1.0 }
		tdir := vnorm(vsub(vmul(r.D, nnt), vmul(n, sign*(ddn*nnt+math.Sqrt(cos2t)))))
		a := nt - nc; b := nt + nc
		R0 := (a * a) / (b * b)
		c2 := 1 - ddn; if into { c2 = 1 + ddn } else { c2 = 1 - vdot(tdir, n) }
		Re := R0 + (1-R0)*c2*c2*c2*c2*c2
		Tr := 1 - Re
		P := .25 + .5*Re
		RP := Re / P
		TP := Tr / (1 - P)
		var result Vec
		if newDepth > 2 {
			if rnd() < P { result = vmul(radiance(reflRay, newDepth), RP) } else { result = vmul(radiance(Ray{x, tdir}, newDepth), TP) }
		} else {
			result = vadd(vmul(radiance(reflRay, newDepth), Re), vmul(radiance(Ray{x, tdir}, newDepth), Tr))
		}
		return vadd(obj.E, vmult(f, result))
	}
}

func clampd(x float64) float64 { if x < 0 { return 0 }; if x > 1 { return 1 }; return x }

func main() {
	for iter := 1; iter <= ITERS; iter++ {
		render(iter == ITERS)
	}
}

func render(doPrint bool) {
	gSeed = 0 // 每一遍都从同一个种子起
	scene()
	cam := Ray{V(50, 52, 295.6), vnorm(V(0, -0.042612, -1))}
	cx := V(float64(W)*.5135/float64(H), 0, 0)
	cy := vmul(vnorm(vcross(cx, cam.D)), .5135)
	cbuf := make([]Vec, W*H)
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			i := (H-y-1)*W + x
			cbuf[i] = Zero
			for sy := 0; sy < 2; sy++ {
				for sx := 0; sx < 2; sx++ {
					rv := Zero
					for s := 1; s <= SAMPS; s++ {
						r1 := 2 * rnd(); r2 := 2 * rnd()
						dx := math.Sqrt(r1) - 1; if r1 >= 1 { dx = 1 - math.Sqrt(2-r1) }
						dy := math.Sqrt(r2) - 1; if r2 >= 1 { dy = 1 - math.Sqrt(2-r2) }
						d := vadd(vadd(vmul(cx, ((float64(sx)+.5+dx)/2+float64(x))/float64(W)-.5),
							vmul(cy, ((float64(sy)+.5+dy)/2+float64(y))/float64(H)-.5)), cam.D)
						camRay := Ray{vadd(cam.O, vmul(d, 140)), vnorm(d)}
						rv = vadd(rv, vmul(radiance(camRay, 0), 1.0/float64(SAMPS)))
						_ = s
					}
					cbuf[i] = vadd(cbuf[i], vmul(V(clampd(rv.X), clampd(rv.Y), clampd(rv.Z)), .25))
				}
			}
		}
	}
	sum := int64(0)
	for i := 0; i < W*H; i++ {
		p := cbuf[i]
		sum += int64(math.Floor(p.X*255)) + int64(math.Floor(p.Y*255)) + int64(math.Floor(p.Z*255))
	}
	if doPrint {
		fmt.Println(sum)
	}
}
