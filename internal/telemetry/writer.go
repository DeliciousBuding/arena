// Package telemetry 提供 JSONL 遥测写入（行级原子写 + 有限轮转）、递归脱敏与
// 运行 manifest 生成，字段命名与 TS 版（W9 数据平台）保持兼容。
package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// JsonlWriter 是 append-only 的 JSONL 行写入器：每条记录先递归脱敏，再以
// 单次底层 Write 落盘为一条完整 JSON 行（O_APPEND 下系统保证行级原子性，
// 不会出现两条记录互相截断/交错）。
type JsonlWriter struct {
	file   *os.File
	path   string
	closed bool
}

// Open 以追加模式打开（或创建）path；父目录不存在时自动创建。
//
// 打开时会做截断恢复：若上次进程在行中间中断（文件尾部不是换行符），
// 将不完整的尾部行截掉，保证之后每一行都是完整 JSON。
func Open(path string) (*JsonlWriter, error) {
	if path == "" {
		return nil, fmt.Errorf("telemetry: open writer: empty path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("telemetry: create dir for %s: %w", path, err)
	}
	if err := repairPartialTail(path); err != nil {
		return nil, fmt.Errorf("telemetry: repair %s: %w", path, err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("telemetry: open %s: %w", path, err)
	}
	return &JsonlWriter{file: file, path: path}, nil
}

// WriteLine 先递归脱敏 record，再序列化为单行 JSON 并原子追加；返回后该行
// 已完整写入（每行必须以完整 JSON 结尾，不允许截断）。
func (w *JsonlWriter) WriteLine(record map[string]any) error {
	if w.closed {
		return fmt.Errorf("telemetry: writer for %s is closed", w.path)
	}
	line, err := json.Marshal(SanitizeValue(record))
	if err != nil {
		return fmt.Errorf("telemetry: marshal record: %w", err)
	}
	line = append(line, '\n')
	if _, err := w.file.Write(line); err != nil {
		return fmt.Errorf("telemetry: write %s: %w", w.path, err)
	}
	return nil
}

// Sync 将已写入数据强制落盘（优雅关闭/检查点路径使用；普通写入已直达内核）。
func (w *JsonlWriter) Sync() error {
	if w.closed {
		return fmt.Errorf("telemetry: writer for %s is closed", w.path)
	}
	if err := w.file.Sync(); err != nil {
		return fmt.Errorf("telemetry: sync %s: %w", w.path, err)
	}
	return nil
}

// Size 返回当前文件大小（轮转判断用）。
func (w *JsonlWriter) Size() (int64, error) {
	if w.closed {
		return 0, fmt.Errorf("telemetry: writer for %s is closed", w.path)
	}
	info, err := w.file.Stat()
	if err != nil {
		return 0, fmt.Errorf("telemetry: stat %s: %w", w.path, err)
	}
	return info.Size(), nil
}

// Close 关闭文件句柄；重复调用安全（幂等）。
func (w *JsonlWriter) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	if err := w.file.Close(); err != nil {
		return fmt.Errorf("telemetry: close %s: %w", w.path, err)
	}
	return nil
}

// repairPartialTail 在文件尾部不是 '\n' 时，把最后一条不完整行截掉
// （崩溃恢复语义：保证打开后写出的每行都是完整 JSON）。
//
// 通过独立句柄完成：读扫描用只读句柄（O_WRONLY 句柄在 Windows 上无读权限），
// 截断用临时 O_WRONLY 句柄（O_APPEND 句柄在 Windows 上无 FILE_WRITE_DATA，
// 无法 Truncate）。主写入句柄保持纯追加语义。
func repairPartialTail(path string) error {
	readFile, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer readFile.Close()
	info, err := readFile.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	if size == 0 {
		return nil
	}
	last := make([]byte, 1)
	if _, err := readFile.ReadAt(last, size-1); err != nil {
		return err
	}
	truncateTo := size
	if last[0] != '\n' {
		// 从尾部向前找最近的行边界。
		const scanChunk = 4096
		truncateTo = 0
		pos := size
		for pos > 0 {
			start := pos - scanChunk
			if start < 0 {
				start = 0
			}
			buf := make([]byte, pos-start)
			if _, err := readFile.ReadAt(buf, start); err != nil {
				return err
			}
			if idx := bytes.LastIndexByte(buf, '\n'); idx >= 0 {
				truncateTo = start + int64(idx) + 1
				break
			}
			pos = start
		}
	}
	if truncateTo == size {
		return nil
	}
	writeFile, err := os.OpenFile(path, os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer writeFile.Close()
	return writeFile.Truncate(truncateTo)
}
