package telemetry

import (
	"fmt"
	"os"
)

// 默认轮转参数：16 MiB 阈值 × 5 代（活动文件 + .1~.4 四份备份），
// 与 TS 版 DEFAULT_JSONL_ROTATION（maxBytes 16MiB、maxBackups 4）语义等价。
const (
	DefaultRotationMaxBytes    = 16 << 20
	DefaultRotationGenerations = 5
)

// RotationConfig 配置 JSONL 有限轮转。
type RotationConfig struct {
	// MaxSizeBytes 为活动文件触发轮转的字节阈值；<= 0 取默认 16 MiB。
	MaxSizeBytes int64
	// MaxGenerations 为保留的总代数（活动文件 + 备份），默认 5；
	// 备份命名为 <path>.1 .. <path>.<MaxGenerations-1>，最旧超出即删除。
	MaxGenerations int
}

// DefaultRotationConfig 返回默认轮转参数（16 MiB / 5 代）。
func DefaultRotationConfig() RotationConfig {
	return RotationConfig{
		MaxSizeBytes:   DefaultRotationMaxBytes,
		MaxGenerations: DefaultRotationGenerations,
	}
}

// normalized 将零值/非法配置归一为默认值。
func (c RotationConfig) normalized() RotationConfig {
	if c.MaxSizeBytes <= 0 {
		c.MaxSizeBytes = DefaultRotationMaxBytes
	}
	if c.MaxGenerations <= 0 {
		c.MaxGenerations = DefaultRotationGenerations
	}
	return c
}

// RotatingWriter 在 JsonlWriter 之上叠加有限轮转：每次写入前若活动文件已达
// 阈值，先滚动备份（active → .1 → .2 → …）再写入整行；轮转只发生在完整行
// 边界（两次写入之间），因此任何文件（活动或备份）都只含完整 JSON 行。
type RotatingWriter struct {
	writer *JsonlWriter
	path   string
	cfg    RotationConfig
	closed bool
}

// OpenRotating 以追加模式打开（或创建）path，并按 cfg 进行有限轮转；
// cfg 为零值时使用默认参数（16 MiB / 5 代）。
func OpenRotating(path string, cfg RotationConfig) (*RotatingWriter, error) {
	if path == "" {
		return nil, fmt.Errorf("telemetry: open rotating writer: empty path")
	}
	writer, err := Open(path)
	if err != nil {
		return nil, err
	}
	return &RotatingWriter{writer: writer, path: path, cfg: cfg.normalized()}, nil
}

// WriteLine 脱敏并追加一条记录；若写入前活动文件已达阈值则先轮转。
func (w *RotatingWriter) WriteLine(record map[string]any) error {
	if w.closed {
		return fmt.Errorf("telemetry: rotating writer for %s is closed", w.path)
	}
	size, err := w.writer.Size()
	if err != nil {
		return err
	}
	if size >= w.cfg.MaxSizeBytes {
		if err := w.rotate(); err != nil {
			return err
		}
	}
	return w.writer.WriteLine(record)
}

// Close 关闭当前活动文件；重复调用安全。
func (w *RotatingWriter) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	return w.writer.Close()
}

// rotate 关闭活动文件后滚动备份链，再打开新的活动文件。
// 顺序：删除最旧备份 → .N-1→.N → … → .1→.2 → active→.1 → 新建 active。
func (w *RotatingWriter) rotate() error {
	if err := w.writer.Close(); err != nil {
		return fmt.Errorf("telemetry: close %s before rotation: %w", w.path, err)
	}
	maxBackup := w.cfg.MaxGenerations - 1
	if maxBackup == 0 {
		if err := os.Remove(w.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("telemetry: remove %s during rotation: %w", w.path, err)
		}
	} else {
		if err := os.Remove(backupPath(w.path, maxBackup)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("telemetry: remove oldest backup: %w", err)
		}
		for gen := maxBackup - 1; gen >= 1; gen-- {
			src := backupPath(w.path, gen)
			if _, err := os.Stat(src); err == nil {
				if err := os.Rename(src, backupPath(w.path, gen+1)); err != nil {
					return fmt.Errorf("telemetry: shift backup %d: %w", gen, err)
				}
			}
		}
		if err := os.Rename(w.path, backupPath(w.path, 1)); err != nil {
			return fmt.Errorf("telemetry: move active to .1: %w", err)
		}
	}
	writer, err := Open(w.path)
	if err != nil {
		return err
	}
	w.writer = writer
	return nil
}

// backupPath 返回第 gen 代备份的路径（gen >= 1）。
func backupPath(path string, gen int) string {
	return fmt.Sprintf("%s.%d", path, gen)
}
