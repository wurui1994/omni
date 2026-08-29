// do-while 里的 continue：跳到**条件那一步**，不是跳循环顶。
// lmfit.asy:574 那个 do 体里就有 continue（odetest/lmfit1 靠它）。
// 量法见 asyDoWhile 的注释：条件里的副作用在 continue 那几轮照样发生一次。

int i=0;
do { ++i; if(i<3) continue; write("body",i); } while(i<5);
write("done",i);

int n=0; int calls=0;
bool cond() { ++calls; return n<4; }
do { ++n; if(n%2==0) continue; write("odd",n); } while(cond());
write("calls",calls);

// break 还得是**跳出这个 do**（不是被 continue 那一格改掉的内层）
int k=0;
do { ++k; if(k==3) break; if(k==1) continue; write("k",k); } while(k<100);
write("afterbreak",k);

// 内层循环自己的 continue 归内层，外层 do 的归外层
string s="";
int p=0;
do {
  ++p;
  for(int q=0; q<3; ++q) { if(q==1) continue; s += string(p)+"."+string(q)+" "; }
  if(p==2) continue;
  s += "[p"+string(p)+"] ";
} while(p<3);
write(s);

// 条件里要摊语句的那一路：`?:` 与赋值都得每轮重算，continue 那一格也一样
int m=0; int seen=0;
do {
  ++m;
  if(m==2) continue;
  ++seen;
} while(m<3 ? true : false);
write("m",m); write("seen",seen);

// do-while 嵌在 for 里：for 的 continue 要先跑更新
int t=0;
for(int a=0; a<3; ++a) {
  int b=0;
  do { ++b; if(b==1) continue; t += 10*a+b; } while(b<2);
  if(a==1) continue;
  t += 100;
}
write("t",t);

// 嵌两层 do-while
int u=0; string w="";
do {
  ++u;
  int v=0;
  do { ++v; if(v==1) continue; w += string(u)+":"+string(v)+" "; } while(v<3);
  if(u==1) continue;
  w += "<"+string(u)+"> ";
} while(u<2);
write(w);
