//go:build !windows

package sysstat

import (
	"syscall"
	"time"
)

// Off Windows (tests, the later Linux packaging) only disk is implemented.
func procTimes(int) (time.Duration, *float64, bool) { return 0, nil, false }

func systemTimes() (time.Duration, time.Duration, bool) { return 0, 0, false }

func memory() (float64, float64, bool) { return 0, 0, false }

func disk(path string) (float64, float64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, false
	}
	total := float64(st.Blocks) * float64(st.Bsize)
	free := float64(st.Bfree) * float64(st.Bsize)
	return (total - free) / (1 << 30), total / (1 << 30), true
}
