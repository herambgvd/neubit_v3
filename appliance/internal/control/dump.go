package control

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
)

// SanitizeDump makes a plain pg_dump safe to replay into the LIVE control
// database, or refuses it — a port of the ops-agent's _sanitize_dump, so a
// backup restores the same way on both deployments.
//
// The refusal matters most: `psql -f` executes meta-commands, and `\!` runs a
// shell command as the database's account. Only the meta-commands pg_dump
// itself emits are accepted. TimescaleDB extension lines are dropped (the
// extension is installed and in use), and the dump's "wait forever" timeouts
// become bounded ones, so a restore under contention fails cleanly instead of
// hanging.
func SanitizeDump(sql []byte) ([]byte, error) {
	allowed := map[string]bool{`\.`: true, `\restrict`: true, `\unrestrict`: true, `\connect`: true}
	var out bytes.Buffer
	inCopy := false
	lines := strings.SplitAfter(string(sql), "\n")
	for i, line := range lines {
		if line == "" {
			continue
		}
		bare := strings.TrimRight(line, "\r\n")
		if inCopy {
			out.WriteString(line)
			if bare == `\.` {
				inCopy = false
			}
			continue
		}
		if meta := metaCommand(line); meta != "" && !allowed[meta] {
			return nil, fmt.Errorf("refusing dump: psql meta-command %q on line %d; only pg_dump's own meta-commands are accepted", meta, i+1)
		}
		out.WriteString(rewriteStatement(line))
		inCopy = copyStart.MatchString(line)
	}
	return out.Bytes(), nil
}

// rewriteStatement is what one non-data, non-meta line becomes: dropped
// (Timescale's extension lines, the PG17 transaction_timeout), bounded (the
// "wait forever" timeouts) or kept.
func rewriteStatement(line string) string {
	trimmed := strings.TrimSpace(line)
	switch {
	case tsExt.MatchString(line), tsComment.MatchString(line),
		strings.HasPrefix(trimmed, "SET transaction_timeout"):
		return ""
	case trimmed == "SET lock_timeout = 0;":
		return "SET lock_timeout = '120s';\n"
	case trimmed == "SET statement_timeout = 0;":
		return "SET statement_timeout = '300s';\n"
	default:
		return line
	}
}

var (
	tsExt     = regexp.MustCompile(`(?i)^\s*(DROP|CREATE)\s+EXTENSION.*timescaledb`)
	tsComment = regexp.MustCompile(`(?i)^\s*COMMENT\s+ON\s+EXTENSION\s+timescaledb`)
	copyStart = regexp.MustCompile(`(?i)^\s*COPY\s.+\sFROM\s+stdin;`)
)

func metaCommand(line string) string {
	s := strings.TrimLeft(line, " \t")
	if !strings.HasPrefix(s, `\`) {
		return ""
	}
	f := strings.Fields(s)
	if len(f) == 0 {
		return ""
	}
	return strings.TrimRight(f[0], "\r\n")
}
