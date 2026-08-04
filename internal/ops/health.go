// Package ops 的 health/ready 检查（docs/go/03-module-spec.md M11 前半）：
// 环境自检 CheckEnvironment 与活锁探测 CheckLiveLock。本文件只做只读探测，
// 绝不创建/清理锁文件、绝不修改 runtime 状态。
//
// fail-closed 原则与 lock.go 一致：任何探测异常一律判 unhealthy（宁可拒启，
// 不误判健康）。Detail 字段只含检查名与结论，绝不输出密钥值、密钥内容或
// 绝对路径。
package ops

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// runtime 布局常量（相对 CWD，与 TS 版部署布局一致）与 hero 密钥 env 名。
const (
	runtimeDirName = "runtime"
	configsDirName = "configs"

	heroAPIKey3Env = "ARENA_HERO_API_KEY_3"
	heroAPIKey4Env = "ARENA_HERO_API_KEY_4"
)

// Check 是单项环境检查结果。Name 为稳定标识；Detail 只含结论，不含
// 密钥值与绝对路径。
type Check struct {
	Name   string
	OK     bool
	Detail string
}

// HealthReport 是一次 CheckEnvironment 的汇总：Healthy 当且仅当全部
// 子项 OK（fail-closed）。
type HealthReport struct {
	Healthy bool
	Checks  []Check
}

// CheckEnvironment 执行 doctor/preflight 的环境自检：
//   - env：ARENA_HERO_API_KEY_3 / ARENA_HERO_API_KEY_4 是否存在
//     （存在性检查，不输出值）；
//   - 配置：runtime/configs/*.json 全部存在且可解析为合法 JSON
//     （encoding/json 的 json.Valid）；
//   - 目录：runtime/ 可写（临时探针文件创建/删除）；
//   - 二进制自检项留待后续扩展。
//
// 单项失败不中断后续检查（报告包含全部子项），但整体 Healthy=false。
func CheckEnvironment() HealthReport {
	checks := []Check{
		checkEnvKey("env."+heroAPIKey3Env, heroAPIKey3Env),
		checkEnvKey("env."+heroAPIKey4Env, heroAPIKey4Env),
		checkConfigFiles(),
		checkRuntimeWritable(),
	}
	healthy := true
	for _, c := range checks {
		if !c.OK {
			healthy = false
		}
	}
	return HealthReport{Healthy: healthy, Checks: checks}
}

// checkEnvKey 检查 env key 是否存在（os.LookupEnv 语义：值存在即为已设置，
// 空值也算）。Detail 只输出 set/not set，绝不输出值。
func checkEnvKey(name, key string) Check {
	if _, ok := os.LookupEnv(key); ok {
		return Check{Name: name, OK: true, Detail: "set"}
	}
	return Check{Name: name, OK: false, Detail: "not set"}
}

// checkConfigFiles 检查 runtime/configs/*.json 存在且全部可解析
// （json.Valid）。目录缺失、无配置文件、任一文件非法 → 不 OK（fail-closed）。
func checkConfigFiles() Check {
	configDir := filepath.Join(runtimeDirName, configsDirName)
	info, err := os.Stat(configDir)
	if err != nil || !info.IsDir() {
		return Check{Name: "configs", OK: false, Detail: "config directory missing"}
	}
	paths, err := filepath.Glob(filepath.Join(configDir, "*.json"))
	if err != nil || len(paths) == 0 {
		return Check{Name: "configs", OK: false, Detail: "no config files found"}
	}
	bad := 0
	for _, p := range paths {
		data, readErr := os.ReadFile(p)
		if readErr != nil || !json.Valid(data) {
			bad++
		}
	}
	if bad > 0 {
		return Check{Name: "configs", OK: false, Detail: fmt.Sprintf("%d config file(s) invalid or unreadable", bad)}
	}
	return Check{Name: "configs", OK: true, Detail: fmt.Sprintf("%d config file(s), all valid JSON", len(paths))}
}

// checkRuntimeWritable 用临时探针文件验证 runtime/ 可写：创建成功且删除
// 成功才算 OK（创建成功但清理失败同样 fail-closed——无法自清理的目录
// 不宜长期使用）。
func checkRuntimeWritable() Check {
	probe, err := os.CreateTemp(runtimeDirName, ".health-probe-*")
	if err != nil {
		return Check{Name: "runtime.writable", OK: false, Detail: "runtime directory not writable (probe create failed)"}
	}
	name := probe.Name()
	if err := probe.Close(); err != nil {
		os.Remove(name)
		return Check{Name: "runtime.writable", OK: false, Detail: "runtime directory not writable (probe close failed)"}
	}
	if err := removeProbeFile(name); err != nil {
		return Check{Name: "runtime.writable", OK: false, Detail: "runtime directory not writable (probe cleanup failed)"}
	}
	return Check{Name: "runtime.writable", OK: true, Detail: "runtime directory writable (probe create/remove OK)"}
}

// removeProbeFile 删除探针文件并容忍 Windows 的 sharing violation 瞬态失败
// （与 lock.go 的 removeLockFile 同一模式）。
func removeProbeFile(name string) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		err = os.Remove(name)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return err
}

// CheckLiveLock 探测 runtime/<tenant>/locks/<tenant>.lock 是否被活进程持有
// （doctor/preflight 用：同租户已有 live writer 则拒绝启 writer）。只读探测，
// 绝不删除或创建锁文件——stale 锁的清理仍由调用方显式 BreakStale() 负责。
//
// 判定复用 lock.go 的 readLockFile/pidAlive（同包私有函数，不修改 lock.go）：
//   - 锁文件不存在 → healthy；
//   - 持有 PID 确证存活，或平台无法确证死亡且锁文件过新（age 未超
//     windowsStaleAge）→ unhealthy（fail-closed：不能确证死亡就按活锁报）；
//   - 持有 PID 确证已死（Unix）或锁文件足够旧（Windows）→ stale 不算活锁
//     → healthy；
//   - 锁文件存在但无法读取/解析 → unhealthy（fail-closed）。
func CheckLiveLock(tenantDir string) (healthy bool, detail string) {
	lockPath := filepath.Join(tenantDir, "locks", filepath.Base(tenantDir)+".lock")
	existing, mtime, err := readLockFile(lockPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return true, "no lock file present"
		}
		return false, "lock file present but unreadable or corrupt"
	}
	age := time.Since(mtime)
	alive, known := pidAlive(existing.PID)
	if (known && alive) || (!known && age <= windowsStaleAge) {
		return false, fmt.Sprintf("lock held by live pid %d (owner %q)", existing.PID, existing.Owner)
	}
	return true, fmt.Sprintf("lock present but owner pid %d not alive (stale); no live writer", existing.PID)
}
