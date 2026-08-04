package main

import (
	"os"
	"strings"
	"testing"
)

func TestRunVersion(t *testing.T) {
	t.Parallel()
	code := run([]string{"version"})
	if code != exitOK {
		t.Fatalf("version exit code = %d, want %d", code, exitOK)
	}
}

func TestRunNoArgs(t *testing.T) {
	t.Parallel()
	code := run(nil)
	if code != exitConfig {
		t.Fatalf("no-args exit code = %d, want %d", code, exitConfig)
	}
}

func TestRunUnknownSubcommand(t *testing.T) {
	t.Parallel()
	code := run([]string{"not-a-command"})
	if code != exitConfig {
		t.Fatalf("unknown subcommand exit code = %d, want %d", code, exitConfig)
	}
}

func TestRunNotImplementedReportsError(t *testing.T) {
	t.Parallel()
	// 未实现的子命令必须显式报错，不得静默成功（防"看着能跑"）。
	oldStderr := os.Stderr
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = writer
	code := run([]string{"tenant"})
	_ = writer.Close()
	os.Stderr = oldStderr
	if code != exitError {
		t.Fatalf("unimplemented subcommand exit code = %d, want %d", code, exitError)
	}
	buf := make([]byte, 4096)
	n, _ := reader.Read(buf)
	output := string(buf[:n])
	if !strings.Contains(output, "not implemented") {
		t.Fatalf("expected explicit not-implemented error, got: %q", output)
	}
}
