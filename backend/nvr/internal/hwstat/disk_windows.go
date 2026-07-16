//go:build windows

package hwstat

import (
	"golang.org/x/sys/windows"
)

// Disk reports filesystem usage on Windows via GetDiskFreeSpaceEx. In practice
// the appliance always runs inside a Linux container (Docker), so this path is
// only exercised for a native Windows build; kept correct for completeness.
func Disk(path string) (DiskUsage, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return DiskUsage{}, err
	}
	var freeAvail, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &freeAvail, &total, &totalFree); err != nil {
		return DiskUsage{}, err
	}
	used := total - freeAvail
	var pct float64
	if total > 0 {
		pct = float64(used) / float64(total) * 100
	}
	return DiskUsage{
		Path:        path,
		TotalBytes:  total,
		FreeBytes:   freeAvail,
		UsedBytes:   used,
		UsedPercent: pct,
	}, nil
}
