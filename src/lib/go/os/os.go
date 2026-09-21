// src/lib/go/os/os.go —— `os` 的**子集**（pt 用到的那几格）。
//
// 文件那几格靠宿主（`omnihost`，见那一份的注）。路径**按字节交过去** ——
// `(cabi …)` 的类型词汇里没有 `cstr`，方言那一层递不了串。
//
// **一格已知的缺口**：打不开时回的是 `(nil, nil)` 而不是 `*PathError`。
// `error` 在图上就是 nil（`NIL_NAMES`），而"一支回 nil、一支回一格记录"是两种形状 ——
// 方言的多返回是一格结构体，形状要单态。于是 `if err != nil` 那一支**进不去**：
// 打不开时后面会在一格空指针上崩（**响的错，不是静默的错答案**）。
// pt 里走这条路的是 `LoadOBJ` / `LoadSTL`（读外部模型文件），那几格例子还没跑到。

package os

import (
	"omnihost"
	"strings"
)

/* 可打印 ASCII（32..126）—— 路径里的字节靠在这张表里找下标换成码。
   为什么不用"取一个字节的码"：图那一层还没有那格节点，而路径就这么长。 */
const ascii = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"

// byteOf 是这一格字符的 ASCII 码；表外的一律当 `?`（63）。
func byteOf(c string) int64 {
	i := strings.Index(ascii, c)
	if i < 0 {
		return 63
	}
	return int64(32 + i)
}

// File 是一格开着的文件。`h` 是宿主那侧的槽号。
type File struct {
	h    int64
	name string
}

// pushPath 把路径逐字节交给宿主。
func pushPath(name string) {
	omnihost.PathReset()
	for i := 0; i < len(name); i++ {
		omnihost.PathPush(byteOf(name[i : i+1]))
	}
}

// Create 建一格新文件（已有的截断）。
func Create(name string) (*File, error) {
	pushPath(name)
	h := omnihost.Open(1)
	if h < 0 {
		return nil, nil
	}
	return &File{h, name}, nil
}

// Open 打开一格已有的文件读。
func Open(name string) (*File, error) {
	pushPath(name)
	h := omnihost.Open(0)
	if h < 0 {
		return nil, nil
	}
	return &File{h, name}, nil
}

// Name 是打开时给的那个路径。
func (f *File) Name() string { return f.name }

// Close 关掉它。
func (f *File) Close() error {
	omnihost.Close(f.h)
	return nil
}

// WriteByte 写一个字节。
func (f *File) WriteByte(b int) error {
	omnihost.Write(f.h, int64(b))
	return nil
}

// Write 写一串字节，回写了几格。
func (f *File) Write(p []int) (int, error) {
	for i := 0; i < len(p); i++ {
		omnihost.Write(f.h, int64(p[i]))
	}
	return len(p), nil
}

// ReadByte 读一个字节；到头了回 -1。
func (f *File) ReadByte() int {
	return int(omnihost.Read(f.h))
}

// IsNotExist 这一格永远回真 —— 见文件头那段"已知的缺口"。
func IsNotExist(err error) bool { return true }
