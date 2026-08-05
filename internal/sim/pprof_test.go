package sim

import (
	"os"
	"runtime/pprof"
	"testing"
)

// TestPprofAlloc：输出分配 profile 供 pprof 分析（go tool pprof --alloc_objects）。
func TestPprofAlloc(t *testing.T) {
	file, err := os.Create("alloc.pprof")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := pprof.StartCPUProfile(file); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		runTicks(1000)
	}
	pprof.StopCPUProfile()
}
