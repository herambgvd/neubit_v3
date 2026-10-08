//go:build !windows

package winsvc

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"
)

// Off Windows the process runs in the foreground; a systemd unit will manage it
// (Linux packaging is a later phase).
func IsService() bool { return false }

func Run(_ string, fn func(ctx context.Context) error) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return fn(ctx)
}

var errUnsupported = errors.New("service management is Windows-only for now")

func Install(string, []string) error { return errUnsupported }
func Uninstall() error               { return errUnsupported }
func Control(string) error           { return errUnsupported }
func Query() string                  { return "unsupported" }
