// Package localauth implements the node's standalone-console authentication:
// argon2id password hashing, login/session issuance, and (Task 3.2) the
// dual-mode request middleware. Local users are a node-local namespace that
// never syncs to central (spec §10.6), so hashes need not interoperate with
// central's Python hasher — but we use the same argon2id primitive + a standard
// PHC-string encoding so the format is portable and self-describing.
package localauth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters. Tuned for an appliance login (interactive, low frequency):
// 64 MiB, 1 pass, 4 lanes → ~tens of ms. Encoded in the hash string so a future
// parameter change stays verifiable against old hashes.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // KiB → 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

// ErrBadHash marks a malformed/unsupported encoded hash.
var ErrBadHash = errors.New("localauth: malformed password hash")

// HashPassword returns a PHC-format argon2id encoding:
//
//	$argon2id$v=19$m=65536,t=1,p=4$<b64salt>$<b64hash>
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword reports whether password matches the encoded argon2id hash,
// re-deriving with the hash's own embedded parameters (constant-time compare).
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	// ["", "argon2id", "v=19", "m=65536,t=1,p=4", salt, hash]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrBadHash
	}
	var mem, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &time, &threads); err != nil {
		return false, ErrBadHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrBadHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, ErrBadHash
	}
	got := argon2.IDKey([]byte(password), salt, time, mem, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
