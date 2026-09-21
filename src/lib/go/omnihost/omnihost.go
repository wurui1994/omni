// src/lib/go/omnihost/omnihost.go —— 标准库那几份桩底下的**宿主入口**。
//
// 这一份里**每一格都没有体**。go 自己也这么写（`runtime.nanotime` 就是一格没有体的
// 声明，体在汇编里）；我们这儿的体在 `libomnigo`（`src/runtime-sched/omni_go.c`），
// 前端靠 `ext/go/tograph.js` 的 `GO_HOST_FNS` 把调用点落成 `(ccall omni_go_…)`。
//
// 为什么要这么一层：`time` / `os` / `image/png` / `fmt` 那几份桩绝大部分能用 go 自己写，
// 而"现在几点""几个核""往文件写一个字节"这三类没法 —— 它们要宿主。把那几格**收在一份
// 文件里**，于是"哪几格靠宿主"一眼数得清，别的桩全是纯 go。
//
// 这不是 go 标准库里的包。`--pkgs` 那条路只认目录，所以它长得与别的桩一样。

package omnihost

// Nanotime 是单调钟的纳秒数（`time.Now` / `time.Since` 靠它）。
func Nanotime() int64

// NumCPU 是在线的核数（`runtime.NumCPU` 靠它）。
func NumCPU() int64

// PathReset 清空攒路径的那格缓冲。
//
// 为什么路径要**按字节攒**：方言那一层递不了串（`(cabi …)` 的类型词汇里没有 `cstr`，
// 见 `src/core/sexpr/lower.js` 的 CABI_CORE 那段注）。所以 `os.Create(name)` 是
// "PathReset、逐字节 PathPush、Open" 三步。那格缓冲是**一份全局的**，中间不能换 goroutine。
func PathReset()

// PathPush 往路径缓冲里追一格字节。
func PathPush(b int64)

// Open 按缓冲里那个路径开一格文件。mode：0 = 读、1 = 写。回槽号；打不开回 -1。
func Open(mode int64) int64

// Write 往那一格写一个字节（C 那侧 stdio 自己带缓冲，所以不是一次系统调用）。
func Write(h int64, b int64)

// Read 从那一格读一个字节；到头了回 -1。
func Read(h int64) int64

// Close 关掉那一格。
func Close(h int64)

// Out 往 stdout 写一个字节（`fmt.Print` 那一族 —— 图上那格 `print` 总带换行）。
func Out(b int64)
