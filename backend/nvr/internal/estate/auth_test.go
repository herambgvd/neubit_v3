package estate

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/neubit/nvr/internal/store"
)

// doJSON issues a request with an optional bearer + JSON body and returns the
// recorder.
func doJSON(t *testing.T, r chi.Router, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	return rr
}

// TestLogin_BootstrapAdmin_ThenAuthenticatedNode is the headline check: logging
// in with the seeded bootstrap admin yields a token that the dual-mode middleware
// then accepts on the authenticated estate API.
func TestLogin_BootstrapAdmin_ThenAuthenticatedNode(t *testing.T) {
	db, _, r := newNode(t)

	// Login via the public endpoint (no prior credentials).
	rr := doJSON(t, r, http.MethodPost, "/api/v1/nvr/estate/auth/login", "",
		map[string]string{"username": "admin", "password": "s3cret"})
	if rr.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}
	var loginResp struct {
		Token string `json:"token"`
		User  struct {
			ID                 string `json:"id"`
			Username           string `json:"username"`
			Role               string `json:"role"`
			MustChangePassword bool   `json:"must_change_password"`
		} `json:"user"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &loginResp); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	if loginResp.Token == "" {
		t.Fatalf("login returned empty token")
	}
	if loginResp.User.Username != "admin" || loginResp.User.Role != "admin" {
		t.Fatalf("login user wrong: %+v", loginResp.User)
	}

	// The token is accepted by the dual-mode middleware on the estate API.
	rr = doJSON(t, r, http.MethodGet, "/api/v1/nvr/estate/node", loginResp.Token, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /estate/node with login token = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}

	// A login audit row was written.
	entries, err := db.ListAudit(context.Background(), 10)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	if !hasAction(entries, "local_user.login") {
		t.Fatalf("expected a local_user.login audit row, got %+v", entries)
	}
}

func TestLogin_BadPassword(t *testing.T) {
	_, _, r := newNode(t)
	rr := doJSON(t, r, http.MethodPost, "/api/v1/nvr/estate/auth/login", "",
		map[string]string{"username": "admin", "password": "wrong"})
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("bad-password login = %d, want 401", rr.Code)
	}
}

func TestLogout_RevokesSession(t *testing.T) {
	_, svc, r := newNode(t)
	token := loginToken(t, svc)

	// Session works before logout.
	if rr := doJSON(t, r, http.MethodGet, "/api/v1/nvr/estate/node", token, nil); rr.Code != http.StatusOK {
		t.Fatalf("pre-logout node = %d, want 200", rr.Code)
	}
	// Logout succeeds.
	if rr := doJSON(t, r, http.MethodPost, "/api/v1/nvr/estate/auth/logout", token, nil); rr.Code != http.StatusNoContent {
		t.Fatalf("logout = %d, want 204", rr.Code)
	}
	// Session no longer authenticates.
	if rr := doJSON(t, r, http.MethodGet, "/api/v1/nvr/estate/node", token, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("post-logout node = %d, want 401", rr.Code)
	}
}

func TestLocalUsers_AdminCRUD(t *testing.T) {
	_, svc, r := newNode(t)
	token := loginToken(t, svc)

	// Create an operator.
	rr := doJSON(t, r, http.MethodPost, "/api/v1/nvr/estate/local-users", token,
		map[string]any{"username": "op1", "password": "pw12345", "role": "operator"})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create user = %d, want 201 (body: %s)", rr.Code, rr.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if _, leaked := created["password_hash"]; leaked {
		t.Fatalf("create response leaked password_hash: %+v", created)
	}
	newID, _ := created["id"].(string)
	if newID == "" {
		t.Fatalf("create returned no id: %+v", created)
	}

	// List includes both the bootstrap admin and the new operator.
	rr = doJSON(t, r, http.MethodGet, "/api/v1/nvr/estate/local-users", token, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("list users = %d, want 200", rr.Code)
	}
	var list struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if list.Total != 2 {
		t.Fatalf("list total = %d, want 2 (%+v)", list.Total, list.Items)
	}

	// Duplicate username → 409.
	rr = doJSON(t, r, http.MethodPost, "/api/v1/nvr/estate/local-users", token,
		map[string]any{"username": "op1", "password": "pw12345"})
	if rr.Code != http.StatusConflict {
		t.Fatalf("duplicate create = %d, want 409", rr.Code)
	}

	// Patch the operator's role to viewer.
	rr = doJSON(t, r, http.MethodPatch, "/api/v1/nvr/estate/local-users/"+newID, token,
		map[string]any{"role": "viewer"})
	if rr.Code != http.StatusOK {
		t.Fatalf("patch user = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}
	var patched map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &patched)
	if patched["role"] != "viewer" {
		t.Fatalf("patch role not applied: %+v", patched)
	}

	// Delete the operator.
	if rr := doJSON(t, r, http.MethodDelete, "/api/v1/nvr/estate/local-users/"+newID, token, nil); rr.Code != http.StatusNoContent {
		t.Fatalf("delete user = %d, want 204", rr.Code)
	}
	if rr := doJSON(t, r, http.MethodGet, "/api/v1/nvr/estate/local-users/"+newID, token, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("get deleted user = %d, want 404", rr.Code)
	}
}

func TestLocalUsers_CannotDeleteBootstrap(t *testing.T) {
	db, svc, r := newNode(t)
	token := loginToken(t, svc)
	// The seeded admin id is "u-admin" (is_bootstrap=1) — deletion must be refused.
	_ = db
	rr := doJSON(t, r, http.MethodDelete, "/api/v1/nvr/estate/local-users/u-admin", token, nil)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("delete bootstrap = %d, want 400", rr.Code)
	}
}

func hasAction(entries []store.AuditEntry, action string) bool {
	for _, e := range entries {
		if e.Action == action {
			return true
		}
	}
	return false
}
