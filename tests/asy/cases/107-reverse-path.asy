path g = (0,0)--(1,0)--(1,1);
path r = reverse(g);
write(length(r));
write(point(r,0)); write(point(r,1)); write(point(r,2));
write(straight(r,0)); write(straight(r,1));
path c = (0,0)--(2,0)--(2,2)--cycle;
path rc = reverse(c);
write(length(rc)); write(cyclic(rc));
write(point(rc,0)); write(point(rc,1)); write(point(rc,2));
