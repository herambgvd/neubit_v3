// Package hwstat reports node-local hardware health for the recorder appliance:
// filesystem usage (the recordings volume) and Linux md RAID array health. It is
// graceful everywhere — on a host without software RAID (or a non-Linux host),
// RaidArrays returns an empty slice rather than erroring, so the box UI simply
// shows "no RAID". Disk() is implemented per-platform (statfs on unix, a stub on
// windows) so the pure-Go binary still builds for every target.
package hwstat

import (
	"bufio"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/neubit/nvr/internal/store"
)

// DiskUsage is filesystem usage for one mounted path (the recordings volume).
type DiskUsage struct {
	Path        string  `json:"path"`
	TotalBytes  uint64  `json:"total_bytes"`
	FreeBytes   uint64  `json:"free_bytes"`
	UsedBytes   uint64  `json:"used_bytes"`
	UsedPercent float64 `json:"used_percent"`
}

// mdstatPath is the kernel's software-RAID summary; overridable in tests.
var mdstatPath = "/proc/mdstat"

var (
	// "md0 : active raid1 sdb1[1] sda1[0]"
	reArray = regexp.MustCompile(`^(md\d+)\s*:\s*(\S+)\s+(raid\d+|linear|multipath|faulty)\s+(.*)$`)
	// "      1046528 blocks super 1.2 [2/1] [U_]"
	reCounts = regexp.MustCompile(`\[(\d+)/(\d+)\]\s*\[([U_]+)\]`)
	// "      [==>..................]  recovery = 12.3% (…) finish=… speed=…"
	reRebuild = regexp.MustCompile(`(recovery|resync|reshape|check)\s*=\s*([\d.]+)%`)
)

// RaidArrays parses /proc/mdstat and returns each array's health. Absent mdstat
// (no software RAID / non-Linux) → (nil, nil): the appliance runs fine without it.
func RaidArrays() ([]store.RaidArray, error) {
	f, err := os.Open(mdstatPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	now := time.Now().UTC()
	var out []store.RaidArray
	var cur *store.RaidArray

	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if m := reArray.FindStringSubmatch(line); m != nil {
			flush()
			state := m[2] // active | inactive
			cur = &store.RaidArray{
				Device:     "/dev/" + m[1],
				Level:      m[3],
				State:      strPtr(state),
				Health:     "unknown",
				LastSeenAt: now,
				UpdatedAt:  now,
			}
			// Count member devices from the trailing "sda1[0] sdb1[1]" tokens.
			cur.TotalDevices = strings.Count(m[4], "[")
			continue
		}
		if cur == nil {
			continue
		}
		if m := reCounts.FindStringSubmatch(line); m != nil {
			total, _ := strconv.Atoi(m[1])
			working, _ := strconv.Atoi(m[2])
			flags := m[3]
			cur.TotalDevices = total
			cur.WorkingDevices = working
			cur.FailedDevices = strings.Count(flags, "_")
		}
		if m := reRebuild.FindStringSubmatch(line); m != nil {
			pct, _ := strconv.ParseFloat(m[2], 64)
			p := int(pct)
			cur.RebuildPercent = &p
			cur.RebuildStatus = strPtr(m[1])
		}
	}
	flush()
	if err := sc.Err(); err != nil {
		return nil, err
	}

	for i := range out {
		out[i].Health = deriveHealth(&out[i])
		if out[i].Health == "degraded" && out[i].FirstDegradedAt == nil {
			t := now
			out[i].FirstDegradedAt = &t
		}
	}
	return out, nil
}

// deriveHealth maps the parsed counters to a health string the UI colour-codes.
func deriveHealth(a *store.RaidArray) string {
	switch {
	case a.RebuildPercent != nil:
		return "rebuilding"
	case a.State != nil && *a.State == "inactive":
		return "failed"
	case a.FailedDevices > 0 || (a.TotalDevices > 0 && a.WorkingDevices < a.TotalDevices):
		return "degraded"
	case a.WorkingDevices > 0:
		return "healthy"
	default:
		return "unknown"
	}
}

func strPtr(s string) *string { return &s }
