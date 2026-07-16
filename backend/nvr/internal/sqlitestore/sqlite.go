// Package sqlitestore is the embedded-SQLite backend of the nvr Store seam — the
// autonomous node's on-disk estate (node.db, WAL mode). It opens the file in the
// Go binary itself (no external DB process) so the node boots and records with
// just its binary + data volume.
package sqlitestore

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite" // pure-Go, CGO-free driver

	"github.com/neubit/nvr/internal/store"
)

// *DB implements the full Store seam (compile-time guarantee).
var _ store.Store = (*DB)(nil)

// DB wraps two handles against the same node.db file: a single serialized writer
// (SQLite is single-writer — MaxOpenConns(1) prevents SQLITE_BUSY on writes) and
// a small read pool. WAL journal mode lets the read pool run concurrently with
// the writer (the recording loop + API + snapshot builder all read while config
// writes happen).
type DB struct {
	rw   *sql.DB // the one writer
	ro   *sql.DB // read pool
	path string
}

// dsn builds the connection string. modernc.org/sqlite applies each `_pragma`
// query parameter on every new connection, so busy_timeout / foreign_keys /
// synchronous are set per-connection; journal_mode=WAL is a persistent property
// of the file once set by the first writer.
func dsn(path string) string {
	return "file:" + path +
		"?_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=foreign_keys(on)" +
		"&_pragma=synchronous(NORMAL)"
}

// Open opens (creating if absent) the SQLite estate at path with WAL + pragmas.
func Open(path string) (*DB, error) {
	d := dsn(path)

	rw, err := sql.Open("sqlite", d)
	if err != nil {
		return nil, fmt.Errorf("open rw: %w", err)
	}
	rw.SetMaxOpenConns(1) // serialize writes

	ro, err := sql.Open("sqlite", d)
	if err != nil {
		rw.Close()
		return nil, fmt.Errorf("open ro: %w", err)
	}
	ro.SetMaxOpenConns(4)

	db := &DB{rw: rw, ro: ro, path: path}
	// Force the WAL pragma to take on the writer connection immediately so the
	// file is in WAL mode before any concurrent readers open.
	if _, err := db.rw.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set wal: %w", err)
	}
	return db, nil
}

// Close closes both handles.
func (d *DB) Close() error {
	e1 := d.rw.Close()
	if err := d.ro.Close(); err != nil {
		return err
	}
	return e1
}
