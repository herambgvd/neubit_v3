package supervise

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Process logs: one file per process, every line prefixed with an RFC 3339 UTC
// timestamp, rotated by size. The timestamp is what lets the control API answer
// "lines since T" the way the ops-agent answered from `docker logs --since`, so a
// following log viewer in the console costs the new lines only.

const (
	// LogMaxBytes is the size at which a log rotates.
	LogMaxBytes = 10 << 20
	// LogKeep is how many rotated files are kept (name.1.log … name.N.log).
	LogKeep = 5
	// maxLine caps one un-terminated line, so a child cannot grow our heap.
	maxLine = 16 << 10
)

// TimeLayout is the line prefix: fixed width, so it sorts and parses cheaply.
const TimeLayout = "2006-01-02T15:04:05.000Z07:00"

// RotatingLog is an io.WriteCloser. Safe for concurrent writers (stdout and
// stderr of one child both write here).
type RotatingLog struct {
	path string
	mu   sync.Mutex
	f    *os.File
	size int64
	part []byte
	now  func() time.Time
}

// OpenLog opens (appending) or creates a process log.
func OpenLog(path string) (*RotatingLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	l := &RotatingLog{path: path, now: time.Now}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *RotatingLog) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.size = f, st.Size()
	return nil
}

// Write splits p into lines and writes each with a timestamp. It never returns
// an error to the child: a full disk must not wedge a process on its stdout.
func (l *RotatingLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(p)
	l.part = append(l.part, p...)
	for {
		i := bytes.IndexByte(l.part, '\n')
		if i < 0 {
			if len(l.part) > maxLine {
				l.emit(l.part[:maxLine])
				l.part = append(l.part[:0], l.part[maxLine:]...)
				continue
			}
			break
		}
		l.emit(l.part[:i])
		l.part = append(l.part[:0], l.part[i+1:]...)
	}
	return n, nil
}

func (l *RotatingLog) emit(line []byte) {
	line = bytes.TrimRight(line, "\r")
	if l.f == nil {
		return
	}
	var b bytes.Buffer
	b.WriteString(l.now().UTC().Format(TimeLayout))
	b.WriteByte(' ')
	b.Write(line)
	b.WriteByte('\n')
	if l.size+int64(b.Len()) > LogMaxBytes {
		l.rotate()
	}
	if l.f == nil {
		return
	}
	if n, err := l.f.Write(b.Bytes()); err == nil {
		l.size += int64(n)
	}
}

func (l *RotatingLog) rotate() {
	_ = l.f.Close()
	l.f = nil
	base := strings.TrimSuffix(l.path, ".log")
	_ = os.Remove(fmt.Sprintf("%s.%d.log", base, LogKeep))
	for i := LogKeep - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d.log", base, i), fmt.Sprintf("%s.%d.log", base, i+1))
	}
	_ = os.Rename(l.path, base+".1.log")
	if err := l.open(); err != nil {
		l.f = nil
	}
}

// Close flushes a trailing partial line and closes the file.
func (l *RotatingLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.part) > 0 {
		l.emit(l.part)
		l.part = nil
	}
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// Tail returns up to n of the newest lines of a process log (reading into the
// previous rotation if the current file is short), keeping only lines stamped
// at or after since (zero = no bound). Oldest first.
func Tail(path string, n int, since time.Time) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}
	base := strings.TrimSuffix(path, ".log")
	var lines []string
	for _, p := range []string{base + ".1.log", path} {
		lines = tailFile(p, n, since, lines)
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}

// tailFile appends p's lines at or after since to lines, trimming as it goes
// so a large file costs at most 2n lines of memory. A missing file adds none.
func tailFile(p string, n int, since time.Time, lines []string) []string {
	f, err := os.Open(p)
	if err != nil {
		return lines
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), maxLine*2)
	for sc.Scan() {
		line := sc.Text()
		if !since.IsZero() && stampedBefore(line, since) {
			continue
		}
		lines = append(lines, line)
		if len(lines) > n*2 {
			lines = append(lines[:0], lines[len(lines)-n:]...)
		}
	}
	return lines
}

// stampedBefore: an unstamped line (a continuation) is never filtered out.
func stampedBefore(line string, since time.Time) bool {
	t, ok := lineTime(line)
	return ok && t.Before(since)
}

func lineTime(line string) (time.Time, bool) {
	if len(line) < len(TimeLayout) {
		return time.Time{}, false
	}
	sp := strings.IndexByte(line, ' ')
	if sp < 0 {
		return time.Time{}, false
	}
	t, err := time.Parse(TimeLayout, line[:sp])
	return t, err == nil
}
