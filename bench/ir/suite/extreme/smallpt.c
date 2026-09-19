/* smallpt 的 **C 基线** —— 与 bench/ir/suite/extreme/smallpt.lua 同一个算法、同一个
 * LCG、同样的运算次序，所以校验和必须一样。
 *
 * 这一份的作用是**知道上限在哪儿**：结构体按值传、编译器把 Vec 全放进寄存器、
 * 一次堆分配都没有。我们那条腿与它的比值，就是"动态语言这层还欠多少"。
 *
 * 规模配置行的形状与 lua / js 那两份一致（bench/ir/extreme.js 按行替换）。
 */
#include <math.h>
#include <stdio.h>

const int W = 48, H = 48, SAMPS = 1;
const int ITERS = 1;   /* 同一个进程里重画几遍（量热态用） */
static void render(int doPrint);

static unsigned g_seed = 0;
static inline double rnd(void) {
    g_seed = 214013u * g_seed + 2531011u;
    return g_seed * (1.0 / 4294967296.0);
}

typedef struct { double x, y, z; } Vec;

static inline Vec V(double x, double y, double z) { Vec v; v.x = x; v.y = y; v.z = z; return v; }
static inline Vec vadd(Vec a, Vec b) { return V(a.x + b.x, a.y + b.y, a.z + b.z); }
static inline Vec vsub(Vec a, Vec b) { return V(a.x - b.x, a.y - b.y, a.z - b.z); }
static inline Vec vmul(Vec a, double b) { return V(a.x * b, a.y * b, a.z * b); }
static inline Vec vmult(Vec a, Vec b) { return V(a.x * b.x, a.y * b.y, a.z * b.z); }
static inline double vdot(Vec a, Vec b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline Vec vnorm(Vec a) { return vmul(a, 1.0 / sqrt(a.x * a.x + a.y * a.y + a.z * a.z)); }
static inline Vec vcross(Vec a, Vec b) {
    return V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

static const Vec Zero = { 0, 0, 0 };
static const Vec XAxis = { 1, 0, 0 };
static const Vec YAxis = { 0, 1, 0 };

enum { DIFF = 0, SPEC = 1, REFR = 2 };

typedef struct { Vec o, d; } Ray;

typedef struct {
    double rad, sqRad, maxC;
    Vec p, e, c, cc;
    int refl;
} Sphere;

static Sphere spheres[9];

static void mk(int i, double rad, Vec p, Vec e, Vec c, int refl) {
    Sphere *s = &spheres[i];
    s->rad = rad; s->p = p; s->e = e; s->c = c; s->refl = refl;
    s->sqRad = rad * rad;
    double m = c.x > c.y ? c.x : c.y;
    s->maxC = m > c.z ? m : c.z;
    s->cc = vmul(c, 1.0 / s->maxC);
}

static void scene(void) {
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

static inline double sph_intersect(const Sphere *s, Ray r) {
    Vec op = vsub(s->p, r.o);
    double b = vdot(op, r.d);
    double det = b * b - vdot(op, op) + s->sqRad;
    double eps = 1e-4;
    if (det < 0) return 0;
    double dets = sqrt(det);
    if (b - dets > eps) return b - dets;
    if (b + dets > eps) return b + dets;
    return 0;
}

static const Sphere *intersect(Ray r, double *tOut) {
    double t = 1e20;
    const Sphere *obj = 0;
    for (int i = 0; i < 9; i++) {
        double d = sph_intersect(&spheres[i], r);
        if (d != 0 && d < t) { t = d; obj = &spheres[i]; }
    }
    *tOut = t;
    return obj;
}

static Vec radiance(Ray r, int depth) {
    double t;
    const Sphere *obj = intersect(r, &t);
    if (obj == 0) return Zero;

    int newDepth = depth + 1;
    int isMaxDepth = newDepth > 100;
    int isUseRR = newDepth > 5;
    int isRR = isUseRR && rnd() < obj->maxC;

    if (isMaxDepth || (isUseRR && !isRR)) return obj->e;

    Vec f = (isUseRR && isRR) ? obj->cc : obj->c;
    Vec x = vadd(r.o, vmul(r.d, t));
    Vec n = vnorm(vsub(x, obj->p));
    Vec nl = vdot(n, r.d) < 0 ? n : vmul(n, -1);

    if (obj->refl == DIFF) {
        double r1 = 2 * M_PI * rnd();
        double r2 = rnd();
        double r2s = sqrt(r2);
        Vec w = nl;
        Vec wo = fabs(w.x) > .1 ? YAxis : XAxis;
        Vec u = vnorm(vcross(wo, w));
        Vec v = vcross(w, u);
        Ray nr;
        nr.o = x;
        nr.d = vnorm(vadd(vadd(vmul(vmul(u, cos(r1)), r2s), vmul(vmul(v, sin(r1)), r2s)),
                          vmul(w, sqrt(1 - r2))));
        return vadd(obj->e, vmult(f, radiance(nr, newDepth)));
    } else if (obj->refl == SPEC) {
        Ray nr;
        nr.o = x;
        nr.d = vsub(r.d, vmul(vmul(n, 2), vdot(n, r.d)));
        return vadd(obj->e, vmult(f, radiance(nr, newDepth)));
    } else {
        Ray reflRay;
        reflRay.o = x;
        reflRay.d = vsub(r.d, vmul(n, 2 * vdot(n, r.d)));
        int into = vdot(n, nl) > 0;
        double nc = 1, nt = 1.5;
        double nnt = into ? nc / nt : nt / nc;
        double ddn = vdot(r.d, nl);
        double cos2t = 1 - nnt * nnt * (1 - ddn * ddn);

        if (cos2t < 0) return vadd(obj->e, vmult(f, radiance(reflRay, newDepth)));

        Vec tdir = vnorm(vsub(vmul(r.d, nnt),
                              vmul(n, (into ? 1 : -1) * (ddn * nnt + sqrt(cos2t)))));
        double a = nt - nc, b = nt + nc;
        double R0 = (a * a) / (b * b);
        double c = 1 - (into ? -ddn : vdot(tdir, n));
        double Re = R0 + (1 - R0) * c * c * c * c * c;
        double Tr = 1 - Re;
        double P = .25 + .5 * Re;
        double RP = Re / P;
        double TP = Tr / (1 - P);

        Vec result;
        Ray tRay; tRay.o = x; tRay.d = tdir;
        if (newDepth > 2) {
            if (rnd() < P) result = vmul(radiance(reflRay, newDepth), RP);
            else result = vmul(radiance(tRay, newDepth), TP);
        } else {
            result = vadd(vmul(radiance(reflRay, newDepth), Re), vmul(radiance(tRay, newDepth), Tr));
        }
        return vadd(obj->e, vmult(f, result));
    }
}

static inline double clampd(double x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

int main(void) {
    for (int iter = 1; iter <= ITERS; iter++) render(iter == ITERS);
    return 0;
}

static void render(int doPrint) {
    g_seed = 0;                 /* 每一遍都从同一个种子起 */
    scene();
    Ray cam;
    cam.o = V(50, 52, 295.6);
    cam.d = vnorm(V(0, -0.042612, -1));
    Vec cx = V(W * .5135 / H, 0, 0);
    Vec cy = vmul(vnorm(vcross(cx, cam.d)), .5135);

    static Vec cbuf[4096 * 4096 / 16];
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            int i = (H - y - 1) * W + x;
            cbuf[i] = Zero;
            for (int sy = 0; sy < 2; sy++) {
                for (int sx = 0; sx < 2; sx++) {
                    Vec r = Zero;
                    for (int s = 1; s <= SAMPS; s++) {
                        double r1 = 2 * rnd();
                        double r2 = 2 * rnd();
                        double dx = r1 < 1 ? sqrt(r1) - 1 : 1 - sqrt(2 - r1);
                        double dy = r2 < 1 ? sqrt(r2) - 1 : 1 - sqrt(2 - r2);
                        Vec d = vadd(vadd(vmul(cx, ((sx + .5 + dx) / 2 + x) / W - .5),
                                          vmul(cy, ((sy + .5 + dy) / 2 + y) / H - .5)),
                                     cam.d);
                        Ray camRay;
                        camRay.o = vadd(cam.o, vmul(d, 140));
                        camRay.d = vnorm(d);
                        r = vadd(r, vmul(radiance(camRay, 0), 1.0 / SAMPS));
                    }
                    cbuf[i] = vadd(cbuf[i], vmul(V(clampd(r.x), clampd(r.y), clampd(r.z)), .25));
                }
            }
        }
    }

    long long sum = 0;
    for (int i = 0; i < W * H; i++) {
        Vec p = cbuf[i];
        sum += (long long)floor(p.x * 255) + (long long)floor(p.y * 255) + (long long)floor(p.z * 255);
    }
    if (doPrint) printf("%lld\n", sum);
}
