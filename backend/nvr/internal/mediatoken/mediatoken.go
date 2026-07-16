// Package mediatoken mints and verifies the node's own short-lived **media
// token** — the live/playback hot-path credential (spec §5.5). It is the Go twin
// of vision's vms/common/media_token.py: an HS256 JWT signed with the node's
// anchor secret (VE_JWT_SECRET — enrollment-shared when the node is enrolled,
// node-local when standalone), carrying the SAME claim shape so a token minted by
// either side verifies on the other.
//
// The browser carries the token as ?token=<t> on every HLS segment / WHEP
// request; the MediaMTX ForwardAuth (GET /api/v1/nvr/media/verify) validates it
// with a single HMAC — no DB hit — before letting the request reach the media
// plane. Distinguished from an access token by sub_type="media" so it can never
// be replayed as an API token (localauth.Authenticate rejects it) and vice-versa.
package mediatoken

import (
	stderrors "errors"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	// alg is HS256 — matches the Python core + vision media_token.py.
	alg = "HS256"
	// subTypeMedia marks a media (streaming) token, distinct from an access token.
	subTypeMedia = "media"
	// defaultTTL is the mint TTL when the caller passes ttl<=0 (matches vision's
	// VE_MEDIA_TOKEN_TTL_SEC default of 300s).
	defaultTTL = 300 * time.Second
)

// ErrInvalid is returned by Verify for any signature/expiry/type problem — the
// public route maps it to a 401/403.
var ErrInvalid = stderrors.New("invalid media token")

// Claims is the media token payload — identical field set + JSON names to
// vision/app/vms/common/media_token.py ({sub_type, tenant_id, camera_id,
// session_id, mode, iat, exp}). RegisteredClaims supplies iat/exp so jwt handles
// expiry validation on Verify.
type Claims struct {
	SubType   string `json:"sub_type"`
	TenantID  string `json:"tenant_id"`
	CameraID  string `json:"camera_id"`
	SessionID string `json:"session_id"`
	Mode      string `json:"mode"`
	jwt.RegisteredClaims
}

// secret returns the node's anchor HMAC key (VE_JWT_SECRET). Read on every
// mint/verify so a key rotation via env restart takes effect; falls back to the
// same default gokernel config uses so a dev boot without the env still works.
func secret() []byte {
	if v := os.Getenv("VE_JWT_SECRET"); v != "" {
		return []byte(v)
	}
	return []byte("change-me-in-prod")
}

// Mint issues a media token for a camera → (token, exp). tenantID is stringified
// as-is; pass "platform" for a NULL-tenant / super-admin session (mirrors vision).
// mode is "live" (default) or "playback"; it is carried as a claim for audit/scope
// but does NOT change the signature — Verify accepts either identically. ttl<=0
// uses the default (300s).
func Mint(cameraID, tenantID, sessionID, mode string, ttl time.Duration) (string, time.Time, error) {
	if ttl <= 0 {
		ttl = defaultTTL
	}
	if mode == "" {
		mode = "live"
	}
	if tenantID == "" {
		tenantID = "platform"
	}
	now := time.Now()
	exp := now.Add(ttl)
	claims := Claims{
		SubType:   subTypeMedia,
		TenantID:  tenantID,
		CameraID:  cameraID,
		SessionID: sessionID,
		Mode:      mode,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret())
	if err != nil {
		return "", time.Time{}, err
	}
	return token, exp, nil
}

// Verify validates a media token and returns its claims. Fast + stateless: a
// single HMAC verify (no DB). Any signature/expiry/type problem → ErrInvalid.
func Verify(token string) (*Claims, error) {
	if token == "" {
		return nil, ErrInvalid
	}
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalid
		}
		return secret(), nil
	}, jwt.WithValidMethods([]string{alg}))
	if err != nil || !parsed.Valid {
		return nil, ErrInvalid
	}
	if claims.SubType != subTypeMedia {
		return nil, ErrInvalid
	}
	if claims.CameraID == "" || claims.SessionID == "" {
		return nil, ErrInvalid
	}
	return claims, nil
}
