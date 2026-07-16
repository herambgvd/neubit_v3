//go:build linux || darwin

package hwstat

import "syscall"

// Disk reports filesystem usage for the mount that contains path (statfs). Works
// on the recorder appliance's Linux container and on a dev mac. Bsize is int64 on
// Linux and uint32 on darwin — uint64(...) normalises both.
func Disk(path string) (DiskUsage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskUsage{}, err
	}
	bs := uint64(st.Bsize)
	total := st.Blocks * bs
	free := st.Bavail * bs // space available to non-root (what actually fills)
	used := total - free
	var pct float64
	if total > 0 {
		pct = float64(used) / float64(total) * 100
	}
	return DiskUsage{
		Path:        path,
		TotalBytes:  total,
		FreeBytes:   free,
		UsedBytes:   used,
		UsedPercent: pct,
	}, nil
}
