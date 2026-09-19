// smallpt：与 bench/ir/suite/extreme/smallpt.lua **同一个算法、同一个 RNG、同样的运算次序**。
//
// 这一份是给 v8（node）做对照的。写法照 smallpt_js 那一版的惯用法（原型上的方法），
// lua 那一版用元表的算子重载 —— 两边都是各自语言里"人会那么写"的形状，
// 比的就是这个。规模（W/H/SAMPS）必须与 lua 那一份一致，否则校验和对不上。

const W = 48, H = 48, SAMPS = 1;
const ITERS = 1;   // 同一个进程里重画几遍（**量热态用**：v8 也要预热）

function RandomLCG(seed) {
  return function () {
    seed = (214013 * seed + 2531011) % 4294967296;
    return seed * (1.0 / 4294967296.0);
  };
}

function Vec(x, y, z) { this.x = x; this.y = y; this.z = z; }
Vec.prototype.add = function (b) { return new Vec(this.x + b.x, this.y + b.y, this.z + b.z); };
Vec.prototype.sub = function (b) { return new Vec(this.x - b.x, this.y - b.y, this.z - b.z); };
Vec.prototype.mul = function (b) { return new Vec(this.x * b, this.y * b, this.z * b); };
Vec.prototype.mult = function (b) { return new Vec(this.x * b.x, this.y * b.y, this.z * b.z); };
Vec.prototype.norm = function () {
  return this.mul(1.0 / Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z));
};
Vec.prototype.dot = function (b) { return this.x * b.x + this.y * b.y + this.z * b.z; };
Vec.prototype.cross = function (b) {
  return new Vec(this.y * b.z - this.z * b.y, this.z * b.x - this.x * b.z, this.x * b.y - this.y * b.x);
};

Vec.Zero = new Vec(0, 0, 0);
Vec.XAxis = new Vec(1, 0, 0);
Vec.YAxis = new Vec(0, 1, 0);
Vec.ZAxis = new Vec(0, 0, 1);

const Refl = { DIFF: 0, SPEC: 1, REFR: 2 };

function Ray(o, d) { this.o = o; this.d = d; }

function Sphere(rad, p, e, c, refl) {
  this.rad = rad; this.p = p; this.e = e; this.c = c; this.refl = refl;
  this.sqRad = rad * rad;
  this.maxC = Math.max(Math.max(c.x, c.y), c.z);
  this.cc = c.mul(1.0 / this.maxC);
}
Sphere.prototype.intersect = function (r) {
  const op = this.p.sub(r.o);
  const b = op.dot(r.d);
  let det = b * b - op.dot(op) + this.sqRad;
  const eps = 1e-4;
  if (det < 0) return 0;
  const dets = Math.sqrt(det);
  if (b - dets > eps) return b - dets;
  if (b + dets > eps) return b + dets;
  return 0;
};

const spheres = [
  new Sphere(1e5, new Vec(1e5 + 1, 40.8, 81.6), Vec.Zero, new Vec(.75, .25, .25), Refl.DIFF),
  new Sphere(1e5, new Vec(-1e5 + 99, 40.8, 81.6), Vec.Zero, new Vec(.25, .25, .75), Refl.DIFF),
  new Sphere(1e5, new Vec(50, 40.8, 1e5), Vec.Zero, new Vec(.75, .75, .75), Refl.DIFF),
  new Sphere(1e5, new Vec(50, 40.8, -1e5 + 170), Vec.Zero, Vec.Zero, Refl.DIFF),
  new Sphere(1e5, new Vec(50, 1e5, 81.6), Vec.Zero, new Vec(.75, .75, .75), Refl.DIFF),
  new Sphere(1e5, new Vec(50, -1e5 + 81.6, 81.6), Vec.Zero, new Vec(.75, .75, .75), Refl.DIFF),
  new Sphere(16.5, new Vec(27, 16.5, 47), Vec.Zero, new Vec(1, 1, 1).mul(.999), Refl.SPEC),
  new Sphere(16.5, new Vec(73, 16.5, 78), Vec.Zero, new Vec(1, 1, 1).mul(.999), Refl.REFR),
  new Sphere(600, new Vec(50, 681.6 - .27, 81.6), new Vec(12, 12, 12), Vec.Zero, Refl.DIFF),
];

let rand = RandomLCG(0);

function clamp(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function intersect(r) {
  let t = 1e20;
  let obj = null;
  for (let i = 0; i < spheres.length; i++) {
    const d = spheres[i].intersect(r);
    if (d !== 0 && d < t) { t = d; obj = spheres[i]; }
  }
  return [obj, t];
}

function radiance(r, depth) {
  const hit = intersect(r);
  const obj = hit[0], t = hit[1];
  if (obj === null) return Vec.Zero;

  const newDepth = depth + 1;
  const isMaxDepth = newDepth > 100;
  const isUseRR = newDepth > 5;
  const isRR = isUseRR && rand() < obj.maxC;

  if (isMaxDepth || (isUseRR && !isRR)) return obj.e;

  const f = (isUseRR && isRR) ? obj.cc : obj.c;
  const x = r.o.add(r.d.mul(t));
  const n = x.sub(obj.p).norm();
  const nl = n.dot(r.d) < 0 ? n : n.mul(-1);

  if (obj.refl === Refl.DIFF) {
    const r1 = 2 * Math.PI * rand();
    const r2 = rand();
    const r2s = Math.sqrt(r2);
    const w = nl;
    const wo = Math.abs(w.x) > .1 ? Vec.YAxis : Vec.XAxis;
    const u = wo.cross(w).norm();
    const v = w.cross(u);
    const d = u.mul(Math.cos(r1)).mul(r2s)
      .add(v.mul(Math.sin(r1)).mul(r2s))
      .add(w.mul(Math.sqrt(1 - r2))).norm();
    return obj.e.add(f.mult(radiance(new Ray(x, d), newDepth)));
  } else if (obj.refl === Refl.SPEC) {
    return obj.e.add(f.mult(radiance(new Ray(x, r.d.sub(n.mul(2).mul(n.dot(r.d)))), newDepth)));
  } else {
    const reflRay = new Ray(x, r.d.sub(n.mul(2 * n.dot(r.d))));
    const into = n.dot(nl) > 0;
    const nc = 1;
    const nt = 1.5;
    const nnt = into ? nc / nt : nt / nc;
    const ddn = r.d.dot(nl);
    const cos2t = 1 - nnt * nnt * (1 - ddn * ddn);

    if (cos2t < 0) return obj.e.add(f.mult(radiance(reflRay, newDepth)));

    const tdir = r.d.mul(nnt).sub(n.mul((into ? 1 : -1) * (ddn * nnt + Math.sqrt(cos2t)))).norm();
    const a = nt - nc;
    const b = nt + nc;
    const R0 = (a * a) / (b * b);
    const c = 1 - (into ? -ddn : tdir.dot(n));
    const Re = R0 + (1 - R0) * c * c * c * c * c;
    const Tr = 1 - Re;
    const P = .25 + .5 * Re;
    const RP = Re / P;
    const TP = Tr / (1 - P);

    let result;
    if (newDepth > 2) {
      if (rand() < P) result = radiance(reflRay, newDepth).mul(RP);
      else result = radiance(new Ray(x, tdir), newDepth).mul(TP);
    } else {
      result = radiance(reflRay, newDepth).mul(Re).add(radiance(new Ray(x, tdir), newDepth).mul(Tr));
    }
    return obj.e.add(f.mult(result));
  }
}

for (let iter = 1; iter <= ITERS; iter++) render(iter === ITERS);

function render(doPrint) {
rand = RandomLCG(0);        // 每一遍都从同一个种子起
const cam = new Ray(new Vec(50, 52, 295.6), new Vec(0, -0.042612, -1).norm());
const cx = new Vec(W * .5135 / H, 0, 0);
const cy = cx.cross(cam.d).norm().mul(.5135);
const cbuf = [];

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (H - y - 1) * W + x;
    cbuf[i] = Vec.Zero;
    for (let sy = 0; sy < 2; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        let r = Vec.Zero;
        for (let s = 1; s <= SAMPS; s++) {
          const r1 = 2 * rand();
          const r2 = 2 * rand();
          const dx = r1 < 1 ? Math.sqrt(r1) - 1 : 1 - Math.sqrt(2 - r1);
          const dy = r2 < 1 ? Math.sqrt(r2) - 1 : 1 - Math.sqrt(2 - r2);
          const d = cx.mul(((sx + .5 + dx) / 2 + x) / W - .5)
            .add(cy.mul(((sy + .5 + dy) / 2 + y) / H - .5))
            .add(cam.d);
          const camRay = new Ray(cam.o.add(d.mul(140)), d.norm());
          r = r.add(radiance(camRay, 0).mul(1.0 / SAMPS));
        }
        cbuf[i] = cbuf[i].add(new Vec(clamp(r.x), clamp(r.y), clamp(r.z)).mul(.25));
      }
    }
  }
}

let sum = 0;
for (let i = 0; i < W * H; i++) {
  const p = cbuf[i];
  sum += Math.floor(p.x * 255) + Math.floor(p.y * 255) + Math.floor(p.z * 255);
}
if (doPrint) console.log(sum);
}
