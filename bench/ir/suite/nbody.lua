local n = 200000
local x, y, z, vx, vy, vz, m = {}, {}, {}, {}, {}, {}, {}
local N = 5
for i = 1, N do
  x[i] = i * 1.5
  y[i] = i * 2.5
  z[i] = i * 0.5
  vx[i] = 0.0
  vy[i] = 0.0
  vz[i] = 0.0
  m[i] = 1.0 + i * 0.1
end
local dt = 0.01
for step = 1, n do
  for i = 1, N do
    for j = 1, N do
      if i ~= j then
        local dx = x[i] - x[j]
        local dy = y[i] - y[j]
        local dz = z[i] - z[j]
        local d2 = dx*dx + dy*dy + dz*dz + 0.0001
        local mag = dt / (d2 * d2)
        vx[i] = vx[i] - dx * m[j] * mag
        vy[i] = vy[i] - dy * m[j] * mag
        vz[i] = vz[i] - dz * m[j] * mag
      end
    end
  end
end
local e = 0.0
for i = 1, N do
  e = e + m[i] * (vx[i]*vx[i] + vy[i]*vy[i] + vz[i]*vz[i])
end
print(e)
