// 文件级循环里的闭包也能抓循环变量：C 式那一格要装箱（`++i` 会改它），
// for-each 那一格每轮新绑一格，按值抓就是对的。soccerball.asy:57 是前一种。
int[] out;
for(int i=0;i<3;++i){
  int[] got=sequence(new int(int k) { return i*10+k; },2);
  out.push(got[0]); out.push(got[1]);
}
for(int j : new int[]{0,1}) {
  int[] g2=sequence(new int(int k) { return j*100+k; },2);
  out.push(g2[0]);
}
write(out.length);
for(int q=0;q<out.length;++q) write(out[q]);
