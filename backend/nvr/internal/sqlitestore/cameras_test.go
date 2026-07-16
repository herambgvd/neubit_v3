package sqlitestore

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/neubit/nvr/internal/store"
)

func TestCameraCRUDWithProfiles(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "node.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	now := time.Now().UTC()
	host := "10.0.0.5"

	cam := store.Camera{
		ID: "c1", Name: "Ch 1", Status: "online", Brand: "onvif", ConnectionType: "onvif",
		RecordingMode: "continuous", RetentionDays: 30, OnvifHost: &host,
		MotionZones: json.RawMessage(`[{"id":"z1"}]`),
		CreatedAt:   now, UpdatedAt: now,
	}
	if err := db.CreateCamera(ctx, cam); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := db.UpsertMediaProfile(ctx, store.MediaProfile{
		ID: "p1", CameraID: "c1", Name: "sub", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("profile: %v", err)
	}

	got, err := db.GetCamera(ctx, "c1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "Ch 1" || len(got.Profiles) != 1 || got.Profiles[0].Name != "sub" {
		t.Fatalf("bad get: %+v", got)
	}
	if got.OnvifHost == nil || *got.OnvifHost != "10.0.0.5" {
		t.Fatalf("nullable string lost: %+v", got.OnvifHost)
	}
	if string(got.MotionZones) != `[{"id":"z1"}]` {
		t.Fatalf("json column lost: %s", got.MotionZones)
	}
	// JSON defaults applied for unset columns.
	if string(got.NetworkInfo) != "{}" || string(got.PrivacyMasks) != "[]" {
		t.Fatalf("json defaults wrong: net=%s masks=%s", got.NetworkInfo, got.PrivacyMasks)
	}

	list, err := db.ListCameras(ctx, store.CameraFilter{})
	if err != nil || len(list) != 1 {
		t.Fatalf("list=%d err=%v", len(list), err)
	}
	if l2, _ := db.ListCameras(ctx, store.CameraFilter{Status: "offline"}); len(l2) != 0 {
		t.Fatalf("status filter broken: %d", len(l2))
	}
	if l3, _ := db.ListCameras(ctx, store.CameraFilter{Name: "Ch"}); len(l3) != 1 {
		t.Fatalf("name filter broken: %d", len(l3))
	}

	got.RetentionDays = 60
	got.UpdatedAt = now.Add(time.Minute)
	if err := db.UpdateCamera(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := db.GetCamera(ctx, "c1")
	if again.RetentionDays != 60 {
		t.Fatalf("update lost")
	}

	if err := db.DeleteCamera(ctx, "c1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := db.GetCamera(ctx, "c1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
	// Profiles cascade-deleted with the camera.
	profs, _ := db.ListMediaProfiles(ctx, "c1")
	if len(profs) != 0 {
		t.Fatalf("cascade failed: %d profiles remain", len(profs))
	}
}
