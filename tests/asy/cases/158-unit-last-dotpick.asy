// 一批：跨单元同签名按位置压 / 点号左边挑"能有这个成员的"那一格

// mod_shb 里 `import mod_sha;` 之后又定义了同签名的 h：后 import 的那一份压住前一份
import mod_sha;
import mod_shb;
h();
write(k(4));   // 只有 mod_sha 里那一份，照旧看得见

// 互不相干的两个模块各有一份同签名的 h 时也一样：这一句之后说的是 mod_shc 那份
import mod_shc;
h();

// 点号左边那个名字有两格：一格是函数、一格是记录 —— 取成员时说的是那格记录
struct Box {
  int n = 7;
  int get() { return n * 2; }
}

Box box;
void box() { write("box()"); }

write(box.n);
write(box.get());
box();
