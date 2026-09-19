// Fidelity check: a Go program that uses cgo (docs/test-results.md, "Real-app fidelity").
package main

/*
#include <stdio.h>
#include <string.h>
static int twice(int x) { return 2 * x; }
static size_t len(const char *s) { return strlen(s); }
*/
import "C"

import (
	"fmt"
	"runtime"
)

func main() {
	fmt.Printf("FID start go %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	cs := C.CString("hello")
	if C.twice(21) == 42 && C.len(cs) == 5 {
		fmt.Println("FID ok cgo: C function called")
	} else {
		fmt.Println("FID fail cgo: wrong answer")
	}
	fmt.Println("FID end")
}
