; omni_prof_msvc_x64.asm —— MSVC 那一档插桩的两个钩子（`/Gh` 与 `/GH` 要的 `_penter`/`_pexit`）
;
; **为什么是一份汇编，而不是两个 C 函数。** 量出来的（`cl /O2 /Gh /GH /FAs`，下面是原文）：
;
;   dsum    PROC
;           call    _penter
;           addsd   xmm0, xmm0      ; <- 入参还在 xmm0 / xmm1 里
;           addsd   xmm0, xmm1
;           call    _pexit          ; <- 返回值在 xmm0 里
;           ret     0
;
;   add4    PROC
;           sub     rsp, 40
;           call    _penter
;           add     r9d, 4          ; <- 入参还在 rcx / rdx / r8 / r9 里
;           add     r8d, 3
;           add     edx, 2
;           inc     ecx
;           call    sink
;           call    _pexit          ; <- 返回值在 eax 里
;           add     rsp, 40
;           ret     0
;
; 也就是说：`call _penter` 摆在**序言之后、参数寄存器还没用之前**，`call _pexit` 摆在
; **返回值已经就位、尾声之前**。于是这两个钩子**必须保住每一个易失寄存器**
; （rax / rcx / rdx / r8-r11 / xmm0-xmm5）—— 而一个 C 函数按 ABI 恰恰可以随便用它们。
; 用 C 写这一对的后果不是"慢一点"，是**每个被插桩的函数的入参与返回值都被改掉**。
; x64 的 MSVC 又没有 `__declspec(naked)`（那一格只有 x86/ARM 有），所以这一格只能是汇编。
;
; `ml64.exe` 与 `cl.exe` 在同一个目录里（工具链自带的汇编器），不是新依赖 —— 见 cli.js 的
; `msvcInstrObjs`。
;
; 寄存器之外还保了**标志位**（`pushfq`）：`call` 前后编译器本来不指望标志位活着，但这一格
; 便宜，留着省一类以后才会咬人的怪事。
;
; 少的一格写在明处：没有 `PROC FRAME` 那套 unwind 数据（这两个钩子不抛、也不被 unwind
; 穿过；真要穿过的是我们自己那个 VEH，而它只印一句就退）。

EXTERN omni_prof_penter_site:PROC
EXTERN omni_prof_pexit_site:PROC

; 进来时 rsp ≡ 8 (mod 16)；`pushfq` 之后 ≡ 0，再 `sub 0D0h`（它 ≡ 0）还是 ≡ 0 ——
; 于是我们自己那一格 `call` 是 16 字节对齐的（ABI 的要求）。
;   [rsp+00h..1Fh]  留给被调者的影子空间（Win64 的规矩，四格）
;   [rsp+20h..57h]  rax/rcx/rdx/r8/r9/r10/r11
;   [rsp+60h..0BFh] xmm0..xmm5
;   [rsp+0D8h]      我们的返回地址 = **被插桩函数里 call 的下一条指令**
OMNI_PROF_SAVE MACRO
    pushfq
    sub     rsp, 0D0h
    mov     [rsp+20h], rax
    mov     [rsp+28h], rcx
    mov     [rsp+30h], rdx
    mov     [rsp+38h], r8
    mov     [rsp+40h], r9
    mov     [rsp+48h], r10
    mov     [rsp+50h], r11
    movups  [rsp+60h], xmm0
    movups  [rsp+70h], xmm1
    movups  [rsp+80h], xmm2
    movups  [rsp+90h], xmm3
    movups  [rsp+0A0h], xmm4
    movups  [rsp+0B0h], xmm5
ENDM

OMNI_PROF_REST MACRO
    movups  xmm0, [rsp+60h]
    movups  xmm1, [rsp+70h]
    movups  xmm2, [rsp+80h]
    movups  xmm3, [rsp+90h]
    movups  xmm4, [rsp+0A0h]
    movups  xmm5, [rsp+0B0h]
    mov     rax, [rsp+20h]
    mov     rcx, [rsp+28h]
    mov     rdx, [rsp+30h]
    mov     r8,  [rsp+38h]
    mov     r9,  [rsp+40h]
    mov     r10, [rsp+48h]
    mov     r11, [rsp+50h]
    add     rsp, 0D0h
    popfq
ENDM

.code

; 函数身份用的是**返回地址**：同一个函数每次进来都是同一个地址（`call _penter` 的下一条），
; 而报告那一侧按"不大于它的最近符号"翻名字，所以落在函数体内是对的。
_penter PROC
    OMNI_PROF_SAVE
    mov     rcx, [rsp+0D8h]
    call    omni_prof_penter_site
    OMNI_PROF_REST
    ret
_penter ENDP

_pexit PROC
    OMNI_PROF_SAVE
    mov     rcx, [rsp+0D8h]
    call    omni_prof_pexit_site
    OMNI_PROF_REST
    ret
_pexit ENDP

END
