// smallpt 的 Java 版本 —— 与 lua/js/c/go 那几份同一个算法、同一个 LCG、同样的运算次序。
// 校验和必须一致。
//
// 为什么要这一条腿：**VM + JIT 这条路的上限是 Java 那一档**（HotSpot 的 C1/C2），
// 不是 v8。所以 Vec 照 Java 里人会写的形状 —— 每次运算 new 一个对象（不可变），
// 让 JIT 自己去做逃逸分析与标量替换；这与 lua 腿"每次运算建一张表"是同一个形状。
//
// 用法: javac -d <out> Smallpt.java && java -cp <out> Smallpt
public final class Smallpt {
    static final int W = 48, H = 48, SAMPS = 1;
    static final int ITERS = 1;   // 同一个进程里重画几遍（**量热态用**：JVM 要预热）

    static int gSeed = 0;

    static double rnd() {
        gSeed = 214013 * gSeed + 2531011;
        return (gSeed & 0xFFFFFFFFL) * (1.0 / 4294967296.0);
    }

    static final class Vec {
        final double x, y, z;
        Vec(double x, double y, double z) { this.x = x; this.y = y; this.z = z; }
    }

    static Vec V(double x, double y, double z) { return new Vec(x, y, z); }
    static Vec vadd(Vec a, Vec b) { return new Vec(a.x + b.x, a.y + b.y, a.z + b.z); }
    static Vec vsub(Vec a, Vec b) { return new Vec(a.x - b.x, a.y - b.y, a.z - b.z); }
    static Vec vmul(Vec a, double b) { return new Vec(a.x * b, a.y * b, a.z * b); }
    static Vec vmult(Vec a, Vec b) { return new Vec(a.x * b.x, a.y * b.y, a.z * b.z); }
    static double vdot(Vec a, Vec b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
    static Vec vnorm(Vec a) { return vmul(a, 1.0 / Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)); }
    static Vec vcross(Vec a, Vec b) {
        return new Vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    }

    static final Vec Zero = new Vec(0, 0, 0);
    static final Vec XAxis = new Vec(1, 0, 0);
    static final Vec YAxis = new Vec(0, 1, 0);

    static final int DIFF = 0, SPEC = 1, REFR = 2;

    static final class Ray {
        final Vec o, d;
        Ray(Vec o, Vec d) { this.o = o; this.d = d; }
    }

    static final class Sphere {
        double rad, sqRad, maxC;
        Vec p, e, c, cc;
        int refl;
    }

    static final Sphere[] spheres = new Sphere[9];

    static void mk(int i, double rad, Vec p, Vec e, Vec c, int refl) {
        Sphere s = new Sphere();
        spheres[i] = s;
        s.rad = rad; s.p = p; s.e = e; s.c = c; s.refl = refl;
        s.sqRad = rad * rad;
        double m = c.x;
        if (c.y > m) m = c.y;
        if (c.z > m) m = c.z;
        s.maxC = m;
        s.cc = vmul(c, 1.0 / s.maxC);
    }

    static void scene() {
        mk(0, 1e5, V(1e5 + 1, 40.8, 81.6), Zero, V(.75, .25, .25), DIFF);
        mk(1, 1e5, V(-1e5 + 99, 40.8, 81.6), Zero, V(.25, .25, .75), DIFF);
        mk(2, 1e5, V(50, 40.8, 1e5), Zero, V(.75, .75, .75), DIFF);
        mk(3, 1e5, V(50, 40.8, -1e5 + 170), Zero, Zero, DIFF);
        mk(4, 1e5, V(50, 1e5, 81.6), Zero, V(.75, .75, .75), DIFF);
        mk(5, 1e5, V(50, -1e5 + 81.6, 81.6), Zero, V(.75, .75, .75), DIFF);
        mk(6, 16.5, V(27, 16.5, 47), Zero, vmul(V(1, 1, 1), .999), SPEC);
        mk(7, 16.5, V(73, 16.5, 78), Zero, vmul(V(1, 1, 1), .999), REFR);
        mk(8, 600, V(50, 681.6 - .27, 81.6), V(12, 12, 12), Zero, DIFF);
    }

    static double sphIntersect(Sphere s, Ray r) {
        Vec op = vsub(s.p, r.o);
        double b = vdot(op, r.d);
        double det = b * b - vdot(op, op) + s.sqRad;
        double eps = 1e-4;
        if (det < 0) return 0;
        double dets = Math.sqrt(det);
        if (b - dets > eps) return b - dets;
        if (b + dets > eps) return b + dets;
        return 0;
    }

    static Sphere hitObj;
    static double hitT;

    static void intersect(Ray r) {
        double t = 1e20;
        Sphere obj = null;
        for (int i = 0; i < spheres.length; i++) {
            double d = sphIntersect(spheres[i], r);
            if (d != 0 && d < t) { t = d; obj = spheres[i]; }
        }
        hitObj = obj; hitT = t;
    }

    static Vec radiance(Ray r, int depth) {
        intersect(r);
        Sphere obj = hitObj;
        double t = hitT;
        if (obj == null) return Zero;

        int newDepth = depth + 1;
        boolean isMaxDepth = newDepth > 100;
        boolean isUseRR = newDepth > 5;
        boolean isRR = isUseRR && rnd() < obj.maxC;

        if (isMaxDepth || (isUseRR && !isRR)) return obj.e;

        Vec f = obj.c;
        if (isUseRR && isRR) f = obj.cc;
        Vec x = vadd(r.o, vmul(r.d, t));
        Vec n = vnorm(vsub(x, obj.p));
        Vec nl = n;
        if (vdot(n, r.d) >= 0) nl = vmul(n, -1);

        if (obj.refl == DIFF) {
            double r1 = 2 * Math.PI * rnd();
            double r2 = rnd();
            double r2s = Math.sqrt(r2);
            Vec w = nl;
            Vec wo = Math.abs(w.x) > .1 ? YAxis : XAxis;
            Vec u = vnorm(vcross(wo, w));
            Vec v = vcross(w, u);
            Vec d = vnorm(vadd(vadd(vmul(vmul(u, Math.cos(r1)), r2s), vmul(vmul(v, Math.sin(r1)), r2s)),
                               vmul(w, Math.sqrt(1 - r2))));
            return vadd(obj.e, vmult(f, radiance(new Ray(x, d), newDepth)));
        } else if (obj.refl == SPEC) {
            return vadd(obj.e, vmult(f, radiance(
                new Ray(x, vsub(r.d, vmul(vmul(n, 2), vdot(n, r.d)))), newDepth)));
        } else {
            Ray reflRay = new Ray(x, vsub(r.d, vmul(n, 2 * vdot(n, r.d))));
            boolean into = vdot(n, nl) > 0;
            double nc = 1.0, nt = 1.5;
            double nnt = into ? nc / nt : nt / nc;
            double ddn = vdot(r.d, nl);
            double cos2t = 1 - nnt * nnt * (1 - ddn * ddn);
            if (cos2t < 0) return vadd(obj.e, vmult(f, radiance(reflRay, newDepth)));
            double sign = into ? 1.0 : -1.0;
            Vec tdir = vnorm(vsub(vmul(r.d, nnt), vmul(n, sign * (ddn * nnt + Math.sqrt(cos2t)))));
            double a = nt - nc, b = nt + nc;
            double R0 = (a * a) / (b * b);
            double c2 = into ? 1 + ddn : 1 - vdot(tdir, n);
            double Re = R0 + (1 - R0) * c2 * c2 * c2 * c2 * c2;
            double Tr = 1 - Re;
            double P = .25 + .5 * Re;
            double RP = Re / P;
            double TP = Tr / (1 - P);
            Vec result;
            if (newDepth > 2) {
                result = rnd() < P ? vmul(radiance(reflRay, newDepth), RP)
                                   : vmul(radiance(new Ray(x, tdir), newDepth), TP);
            } else {
                result = vadd(vmul(radiance(reflRay, newDepth), Re),
                              vmul(radiance(new Ray(x, tdir), newDepth), Tr));
            }
            return vadd(obj.e, vmult(f, result));
        }
    }

    static double clampd(double x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

    public static void main(String[] args) {
        for (int iter = 1; iter <= ITERS; iter++) render(iter == ITERS);
    }

    static void render(boolean print) {
        gSeed = 0;                 // 每一遍都从同一个种子起
        scene();
        Ray cam = new Ray(V(50, 52, 295.6), vnorm(V(0, -0.042612, -1)));
        Vec cx = V((double) W * .5135 / (double) H, 0, 0);
        Vec cy = vmul(vnorm(vcross(cx, cam.d)), .5135);
        Vec[] cbuf = new Vec[W * H];
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                int i = (H - y - 1) * W + x;
                cbuf[i] = Zero;
                for (int sy = 0; sy < 2; sy++) {
                    for (int sx = 0; sx < 2; sx++) {
                        Vec rv = Zero;
                        for (int s = 1; s <= SAMPS; s++) {
                            double r1 = 2 * rnd(), r2 = 2 * rnd();
                            double dx = r1 < 1 ? Math.sqrt(r1) - 1 : 1 - Math.sqrt(2 - r1);
                            double dy = r2 < 1 ? Math.sqrt(r2) - 1 : 1 - Math.sqrt(2 - r2);
                            Vec d = vadd(vadd(
                                vmul(cx, (((double) sx + .5 + dx) / 2 + (double) x) / (double) W - .5),
                                vmul(cy, (((double) sy + .5 + dy) / 2 + (double) y) / (double) H - .5)), cam.d);
                            Ray camRay = new Ray(vadd(cam.o, vmul(d, 140)), vnorm(d));
                            rv = vadd(rv, vmul(radiance(camRay, 0), 1.0 / (double) SAMPS));
                        }
                        cbuf[i] = vadd(cbuf[i], vmul(V(clampd(rv.x), clampd(rv.y), clampd(rv.z)), .25));
                    }
                }
            }
        }
        long sum = 0;
        for (int i = 0; i < W * H; i++) {
            Vec p = cbuf[i];
            sum += (long) Math.floor(p.x * 255) + (long) Math.floor(p.y * 255) + (long) Math.floor(p.z * 255);
        }
        if (print) System.out.println(sum);
    }
}