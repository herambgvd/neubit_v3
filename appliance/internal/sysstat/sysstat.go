// Package sysstat samples host and per-process CPU and memory, for the control
// API's ops-agent-compatible /containers and /host (the Docker stack read the
// same numbers from `docker stats`).
package sysstat

import (
	"runtime"
	"sync"
	"time"
)

// Host is the machine summary.
type Host struct {
	CPUPct      *float64
	CPUCount    int
	MemUsedMB   *float64
	MemTotalMB  *float64
	DiskUsedGB  *float64
	DiskTotalGB *float64
}

// Proc is one process's figures; nil when unknown.
type Proc struct {
	CPUPct *float64
	MemMB  *float64
}

// Sampler turns cumulative CPU time into a percentage between two calls.
type Sampler struct {
	mu   sync.Mutex
	last map[int]cpuMark
	host cpuMark
}

type cpuMark struct {
	busy time.Duration
	at   time.Time
	// For the host: idle and total since boot.
	idle, total time.Duration
}

func NewSampler() *Sampler { return &Sampler{last: map[int]cpuMark{}} }

// Procs samples each pid. The first call for a pid has no CPU figure yet.
func (s *Sampler) Procs(pids []int) map[int]Proc {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	out := make(map[int]Proc, len(pids))
	seen := map[int]bool{}
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		seen[pid] = true
		busy, mem, ok := procTimes(pid)
		if !ok {
			continue
		}
		p := Proc{MemMB: mem}
		if prev, had := s.last[pid]; had {
			wall := now.Sub(prev.at)
			if wall > 0 && busy >= prev.busy {
				v := round2(float64(busy-prev.busy) / float64(wall) * 100)
				p.CPUPct = &v
			}
		}
		s.last[pid] = cpuMark{busy: busy, at: now}
		out[pid] = p
	}
	for pid := range s.last {
		if !seen[pid] {
			delete(s.last, pid)
		}
	}
	return out
}

// Host samples the machine; diskPath picks the drive (the data root's).
func (s *Sampler) Host(diskPath string) Host {
	h := Host{CPUCount: runtime.NumCPU()}
	if idle, total, ok := systemTimes(); ok {
		s.mu.Lock()
		prev := s.host
		s.host = cpuMark{idle: idle, total: total}
		s.mu.Unlock()
		if prev.total > 0 && total > prev.total {
			v := round2(100 * (1 - float64(idle-prev.idle)/float64(total-prev.total)))
			h.CPUPct = &v
		}
	}
	if used, total, ok := memory(); ok {
		u, t := round1(used), round1(total)
		h.MemUsedMB, h.MemTotalMB = &u, &t
	}
	if used, total, ok := disk(diskPath); ok {
		u, t := round1(used), round1(total)
		h.DiskUsedGB, h.DiskTotalGB = &u, &t
	}
	return h
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
