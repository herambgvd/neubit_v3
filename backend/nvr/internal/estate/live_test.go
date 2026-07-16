package estate

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/neubit/nvr/internal/mediatoken"
	"github.com/neubit/nvr/internal/store"
)

// TestEstateLive_MintsVerifiableToken asserts POST /estate/cameras/{id}/live
// returns a media token that mediatoken.Verify accepts, and browser URLs carrying
// that token.
func TestEstateLive_MintsVerifiableToken(t *testing.T) {
	db, svc, r := newNode(t)
	ctx := context.Background()
	now := time.Now().UTC()
	if err := db.CreateCamera(ctx, store.Camera{
		ID: "cam-live", Name: "Ch 1", Status: "online", Brand: "onvif",
		RecordingMode: "continuous", RetentionDays: 30, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed camera: %v", err)
	}

	token := loginToken(t, svc)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/nvr/estate/cameras/cam-live/live", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}
	var body struct {
		SessionID string `json:"session_id"`
		CameraID  string `json:"camera_id"`
		HLSURL    string `json:"hls_url"`
		WebRTCURL string `json:"webrtc_url"`
		Token     string `json:"token"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Token == "" || body.CameraID != "cam-live" || body.SessionID == "" {
		t.Fatalf("live body wrong: %+v", body)
	}
	claims, err := mediatoken.Verify(body.Token)
	if err != nil {
		t.Fatalf("minted token not verifiable: %v", err)
	}
	if claims.CameraID != "cam-live" || claims.Mode != "live" || claims.SessionID != body.SessionID {
		t.Fatalf("claims mismatch: %+v", claims)
	}
	// The browser URLs carry the token so /media/verify authorises the segments.
	if !bytes.Contains([]byte(body.HLSURL), []byte("token=")) || body.WebRTCURL == "" {
		t.Fatalf("urls missing token: hls=%q whep=%q", body.HLSURL, body.WebRTCURL)
	}
}

// TestEstateRecordings_ListsIndex asserts GET /estate/recordings returns the local
// recording-segment index for a camera in the requested window.
func TestEstateRecordings_ListsIndex(t *testing.T) {
	db, svc, r := newNode(t)
	ctx := context.Background()
	now := time.Now().UTC()
	if err := db.CreateCamera(ctx, store.Camera{
		ID: "cam-rec", Name: "Ch 2", Status: "online", Brand: "onvif",
		RecordingMode: "continuous", RetentionDays: 30, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed camera: %v", err)
	}
	started := now.Add(-2 * time.Minute)
	ended := now.Add(-1 * time.Minute)
	dur := 60.0
	size := int64(1024)
	codec := "H264"
	if _, err := db.UpsertRecordingSegment(ctx, store.RecordingSegment{
		Path: "/recordings/cam-rec/seg-1.mp4", TenantID: "platform", CameraID: "cam-rec",
		Profile: "main", StartedAt: &started, EndedAt: &ended, Duration: &dur,
		FileSize: &size, Codec: &codec, TriggerType: "continuous", IntegrityStatus: "ok",
	}); err != nil {
		t.Fatalf("seed segment: %v", err)
	}

	token := loginToken(t, svc)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/recordings?camera_id=cam-rec", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}
	var body struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Total != 1 || len(body.Items) != 1 {
		t.Fatalf("recordings list wrong: %+v", body)
	}
	if body.Items[0]["path"] != "/recordings/cam-rec/seg-1.mp4" || body.Items[0]["camera_id"] != "cam-rec" {
		t.Fatalf("recording item wrong: %+v", body.Items[0])
	}
}

// TestEstateRecordings_RequiresCameraID asserts the list rejects a missing filter.
func TestEstateRecordings_RequiresCameraID(t *testing.T) {
	_, svc, r := newNode(t)
	token := loginToken(t, svc)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nvr/estate/recordings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest && rr.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 400/422 for missing camera_id", rr.Code)
	}
}
