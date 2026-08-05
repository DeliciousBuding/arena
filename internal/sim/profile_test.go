package sim

import (
	"runtime"
	"testing"
)

// TestProfileAlloc：快速分配热点探测（-benchmem 下看每次评估分配量）。
func TestProfileAlloc(t *testing.T) {
	var stats runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&stats)
	before := stats.TotalAlloc
	for i := 0; i < 10; i++ {
		runTicks(1000)
	}
	runtime.ReadMemStats(&stats)
	allocPerEval := (stats.TotalAlloc - before) / 10
	t.Logf("alloc per 1000-tick eval: %d bytes", allocPerEval)
}
