void dump(path g) {
  write(length(g)); write(cyclic(g));
  for (int i = 0; i < size(g); ++i) {
    write(precontrol(g,i)); write(point(g,i)); write(postcontrol(g,i));
  }
}
dump((0,0)..(1,1)..(2,0)..(3,3));
dump((0,0)..(1,1)..(2,0)..cycle);
dump((0,0)--(1,0)..(2,1)..(3,0)--(4,0));
dump((0,0)..(1,0)--(2,1)..cycle);
dump((0,0)..(0,0)..(1,1));
dump((0,0)..(1,1));
dump((2,3));
dump((0,0)--(1,1)--cycle);
