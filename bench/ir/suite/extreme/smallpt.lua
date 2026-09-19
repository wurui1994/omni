-- smallpt：路径追踪（Kevin Beason 的 99 行 smallpt，照 smallpt_lua 那一版移植）
--
-- 这是**极端例子**：向量全靠元表的算子重载（`__add`/`__sub`/`__mul`/`__mod`），
-- 每条光线递归、每次反弹都新建几个对象，外加闭包 RNG 与 libm 那一族。
-- 原版是 256x256、100spp，跑不完 —— 这儿按 W/H/SAMPS 缩小，时间可控。
-- 输出不写 ppm，印一格整数校验和（好逐字节比）。

local W, H, SAMPS = 48, 48, 1     -- SAMPS*4 = 每像素采样数
local ITERS = 1                   -- 同一个进程里重画几遍（**量热态用**，见 bench/ir/extreme.js）

local function RandomLCG(seed)
  return function()
    seed = (214013 * seed + 2531011) % 4294967296
    return seed * (1.0 / 4294967296.0)
  end
end

Vec = {}
Vec.__index = Vec

function Vec.new(x_, y_, z_)
  local self = { x = x_, y = y_, z = z_ }
  setmetatable(self, Vec)
  return self
end

function Vec.__add(a, b) return Vec.new(a.x + b.x, a.y + b.y, a.z + b.z) end
function Vec.__sub(a, b) return Vec.new(a.x - b.x, a.y - b.y, a.z - b.z) end
function Vec.__mul(a, b) return Vec.new(a.x * b, a.y * b, a.z * b) end
function Vec:mult(b) return Vec.new(self.x * b.x, self.y * b.y, self.z * b.z) end
function Vec:norm()
  return self * (1.0 / math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z))
end
function Vec:dot(b) return self.x * b.x + self.y * b.y + self.z * b.z end
function Vec.__mod(a, b)
  return Vec.new(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
end

Vec.Zero = Vec.new(0, 0, 0)
Vec.XAxis = Vec.new(1, 0, 0)
Vec.YAxis = Vec.new(0, 1, 0)
Vec.ZAxis = Vec.new(0, 0, 1)

Refl = { DIFF = 0, SPEC = 1, REFR = 2 }

Ray = {}
Ray.__index = Ray
function Ray.new(o_, d_)
  local self = { o = o_, d = d_ }
  setmetatable(self, Ray)
  return self
end

Sphere = {}
Sphere.__index = Sphere
function Sphere.new(rad_, p_, e_, c_, refl_)
  local self = { rad = rad_, p = p_, e = e_, c = c_, refl = refl_ }
  self.sqRad = rad_ * rad_
  self.maxC = math.max(math.max(c_.x, c_.y), c_.z)
  self.cc = c_ * (1.0 / self.maxC)
  setmetatable(self, Sphere)
  return self
end

function Sphere:intersect(r)
  local op = self.p - r.o
  local b = op:dot(r.d)
  local det = b * b - op:dot(op) + self.sqRad
  local eps = 1e-4
  if det < 0 then
    return 0
  else
    local dets = math.sqrt(det)
    if b - dets > eps then
      return b - dets
    elseif b + dets > eps then
      return b + dets
    else
      return 0
    end
  end
end

spheres = {
  Sphere.new(1e5,  Vec.new( 1e5+1,40.8,81.6),  Vec.Zero, Vec.new(.75,.25,.25), Refl.DIFF),
  Sphere.new(1e5,  Vec.new(-1e5+99,40.8,81.6), Vec.Zero, Vec.new(.25,.25,.75), Refl.DIFF),
  Sphere.new(1e5,  Vec.new(50,40.8, 1e5),      Vec.Zero, Vec.new(.75,.75,.75), Refl.DIFF),
  Sphere.new(1e5,  Vec.new(50,40.8,-1e5+170),  Vec.Zero, Vec.Zero,             Refl.DIFF),
  Sphere.new(1e5,  Vec.new(50, 1e5, 81.6),     Vec.Zero, Vec.new(.75,.75,.75), Refl.DIFF),
  Sphere.new(1e5,  Vec.new(50,-1e5+81.6,81.6), Vec.Zero, Vec.new(.75,.75,.75), Refl.DIFF),
  Sphere.new(16.5, Vec.new(27,16.5,47),        Vec.Zero, Vec.new(1,1,1)*.999,  Refl.SPEC),
  Sphere.new(16.5, Vec.new(73,16.5,78),        Vec.Zero, Vec.new(1,1,1)*.999,  Refl.REFR),
  Sphere.new(600,  Vec.new(50,681.6-.27,81.6), Vec.new(12,12,12), Vec.Zero,    Refl.DIFF)
}

rand = RandomLCG(0)

function clamp(x)
  if x < 0 then return 0 elseif x > 1 then return 1 else return x end
end

function intersect(r)
  local t = 1e20
  local obj
  for i, s in ipairs(spheres) do
    local d = s:intersect(r)
    if d ~= 0 and d < t then
      t = d
      obj = s
    end
  end
  return obj, t
end

function radiance(r, depth)
  local obj, t
  obj, t = intersect(r)

  if obj == nil then
    return Vec.Zero
  else
    local newDepth = depth + 1
    local isMaxDepth = newDepth > 100
    local isUseRR = newDepth > 5
    local isRR = isUseRR and rand() < obj.maxC

    if isMaxDepth or (isUseRR and not isRR) then
      return obj.e
    else
      local f = (isUseRR and isRR) and obj.cc or obj.c
      local x = r.o + r.d * t
      local n = (x - obj.p):norm()
      local nl = (n:dot(r.d) < 0) and n or (n * -1)

      if obj.refl == Refl.DIFF then
        local r1 = 2 * math.pi * rand()
        local r2 = rand()
        local r2s = math.sqrt(r2)
        local w = nl
        local wo = (math.abs(w.x) > .1) and Vec.YAxis or Vec.XAxis
        local u = (wo % w):norm()
        local v = w % u
        local d = (u * math.cos(r1) * r2s + v * math.sin(r1) * r2s + w * math.sqrt(1 - r2)):norm()
        return obj.e + f:mult(radiance(Ray.new(x, d), newDepth))
      elseif obj.refl == Refl.SPEC then
        return obj.e + f:mult(radiance(Ray.new(x, r.d - n * 2 * n:dot(r.d)), newDepth))
      else
        local reflRay = Ray.new(x, r.d - n * (2 * n:dot(r.d)))
        local into = n:dot(nl) > 0
        local nc = 1
        local nt = 1.5
        local nnt = into and (nc / nt) or (nt / nc)
        local ddn = r.d:dot(nl)
        local cos2t = 1 - nnt * nnt * (1 - ddn * ddn)

        if cos2t < 0 then
          return obj.e + f:mult(radiance(reflRay, newDepth))
        else
          local tdir = (r.d * nnt - n * ((into and 1 or -1) * (ddn * nnt + math.sqrt(cos2t)))):norm()
          local a = nt - nc
          local b = nt + nc
          local R0 = (a * a) / (b * b)
          local c = 1 - (into and -ddn or tdir:dot(n))
          local Re = R0 + (1 - R0) * c * c * c * c * c
          local Tr = 1 - Re
          local P = .25 + .5 * Re
          local RP = Re / P
          local TP = Tr / (1 - P)

          local result
          if newDepth > 2 then
            if rand() < P then
              result = radiance(reflRay, newDepth) * RP
            else
              result = radiance(Ray.new(x, tdir), newDepth) * TP
            end
          else
            result = radiance(reflRay, newDepth) * Re + radiance(Ray.new(x, tdir), newDepth) * Tr
          end
          return obj.e + f:mult(result)
        end
      end
    end
  end
end

for iter = 1, ITERS do
rand = RandomLCG(0)        -- 每一遍都从同一个种子起，所以每一遍的校验和都一样
local cam = Ray.new(Vec.new(50, 52, 295.6), Vec.new(0, -0.042612, -1):norm())
local cx = Vec.new(W * .5135 / H, 0, 0)
local cy = (cx % cam.d):norm() * .5135
local c = {}

for y = 0, H - 1 do
  for x = 0, W - 1 do
    local i = (H - y - 1) * W + x
    c[i] = Vec.Zero
    for sy = 0, 1 do
      for sx = 0, 1 do
        local r = Vec.Zero
        for s = 1, SAMPS do
          local r1 = 2 * rand()
          local r2 = 2 * rand()
          local dx = (r1 < 1) and (math.sqrt(r1) - 1) or (1 - math.sqrt(2 - r1))
          local dy = (r2 < 1) and (math.sqrt(r2) - 1) or (1 - math.sqrt(2 - r2))
          local d = cx * (((sx + .5 + dx) / 2 + x) / W - .5) +
                    cy * (((sy + .5 + dy) / 2 + y) / H - .5) + cam.d
          local camRay = Ray.new(cam.o + d * 140, d:norm())
          r = r + radiance(camRay, 0) * (1.0 / SAMPS)
        end
        c[i] = c[i] + Vec.new(clamp(r.x), clamp(r.y), clamp(r.z)) * .25
      end
    end
  end
end

-- 校验和：线性亮度 × 255 取整（不用 ^，免得跨实现的 pow 差最后一位）
local sum = 0
for i = 0, W * H - 1 do
  local p = c[i]
  sum = sum + math.floor(p.x * 255) + math.floor(p.y * 255) + math.floor(p.z * 255)
end
if iter == ITERS then print(sum) end
end
