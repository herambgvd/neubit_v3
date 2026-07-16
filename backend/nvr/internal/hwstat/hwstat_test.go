package hwstat

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiskUsage(t *testing.T) {
	du, err := Disk(t.TempDir())
	if err != nil {
		t.Fatalf("Disk: %v", err)
	}
	if du.TotalBytes == 0 {
		t.Fatalf("expected a non-zero total, got %+v", du)
	}
	if du.UsedBytes+du.FreeBytes > du.TotalBytes+du.TotalBytes {
		t.Fatalf("used+free wildly off: %+v", du)
	}
	if du.UsedPercent < 0 || du.UsedPercent > 100 {
		t.Fatalf("used_percent out of range: %v", du.UsedPercent)
	}
}

const sampleMdstat = `Personalities : [raid1] [raid5] [raid6]
md0 : active raid1 sdb1[1] sda1[0]
      1046528 blocks super 1.2 [2/2] [UU]

md1 : active raid5 sdd1[3] sdc1[1] sde1[0]
      2093056 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [UU_]
      [=====>...............]  recovery = 26.5% (556000/2093056) finish=2.0min speed=4000K/sec

unused devices: <none>
`

func TestRaidArraysParse(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "mdstat")
	if err := os.WriteFile(p, []byte(sampleMdstat), 0o644); err != nil {
		t.Fatal(err)
	}
	old := mdstatPath
	mdstatPath = p
	defer func() { mdstatPath = old }()

	arrays, err := RaidArrays()
	if err != nil {
		t.Fatalf("RaidArrays: %v", err)
	}
	if len(arrays) != 2 {
		t.Fatalf("want 2 arrays, got %d: %+v", len(arrays), arrays)
	}

	// md0 — healthy raid1.
	a0 := arrays[0]
	if a0.Device != "/dev/md0" || a0.Level != "raid1" || a0.Health != "healthy" {
		t.Fatalf("md0 bad: %+v", a0)
	}
	if a0.TotalDevices != 2 || a0.WorkingDevices != 2 || a0.FailedDevices != 0 {
		t.Fatalf("md0 counts: %+v", a0)
	}

	// md1 — raid5 with a failed member, rebuilding.
	a1 := arrays[1]
	if a1.Device != "/dev/md1" || a1.Level != "raid5" {
		t.Fatalf("md1 bad: %+v", a1)
	}
	if a1.TotalDevices != 3 || a1.WorkingDevices != 2 || a1.FailedDevices != 1 {
		t.Fatalf("md1 counts: %+v", a1)
	}
	if a1.Health != "rebuilding" || a1.RebuildPercent == nil || *a1.RebuildPercent != 26 {
		t.Fatalf("md1 rebuild: health=%s pct=%v", a1.Health, a1.RebuildPercent)
	}
}

func TestRaidArraysAbsent(t *testing.T) {
	old := mdstatPath
	mdstatPath = filepath.Join(t.TempDir(), "does-not-exist")
	defer func() { mdstatPath = old }()

	arrays, err := RaidArrays()
	if err != nil {
		t.Fatalf("absent mdstat should be graceful, got err: %v", err)
	}
	if len(arrays) != 0 {
		t.Fatalf("want no arrays, got %d", len(arrays))
	}
}
