// EPS 里的**颜色**：三档的发法与挑法照 psfile.cc:184 的 setcolor —— 先 cmyk
// （`c m y k setcmykcolor`，**不转成 rgb**，量过 `cmyk(1,0,0.5,0.2)`）、
// 再 rgb（`r g b setrgbcolor`）、最后灰（`g setgray`）。
// 笔的状态是**增量**发的：与上一支笔相同的那几行不发；颜色空间换了就算不同。
size(100);
fill((0,0)--(100,0)--(100,100)--cycle, gray(0.4));
draw((0,0)--(100,100), cmyk(1,0,0.5,0.2));
draw((0,50)--(100,50), rgb(0.1,0.2,0.9));
draw((0,70)--(100,70), black+linewidth(0.7));
draw((0,80)--(100,80), gray(0.4));          // 又回到灰：只发变了的那几行
draw((0,90)--(100,90), cmyk(1,0,0.5,0.2)); // 又回到同一支 cmyk
shipout(currentpicture);
