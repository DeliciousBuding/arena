package ops

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- CheckEnvironment 测试辅助 ---

// chdirToRuntime 在临时目录中搭出 runtime/configs 布局（files 为 configs
// 目录内 文件名 → 内容），并把测试进程 CWD 切到该目录，保证不扫描真实
// 仓库的 runtime/。返回临时根目录。
func chdirToRuntime(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	configDir := filepath.Join(root, "runtime", "configs")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(configDir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(root)
	return root
}

// clearEnvKey 清空 env key（测试期间），结束后恢复原值——保证测试不依赖
// 机器上真实的密钥 env。
func clearEnvKey(t *testing.T, key string) {
	t.Helper()
	old, had := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if had {
			os.Setenv(key, old)
		}
	})
}

// setBothKeys 注入两个测试密钥（值仅为占位，不依赖真实密钥）。
func setBothKeys(t *testing.T) {
	t.Helper()
	t.Setenv(heroAPIKey3Env, "test-key-3")
	t.Setenv(heroAPIKey4Env, "test-key-4")
}

// findCheck 按 Name 从报告中取单项检查。
func findCheck(t *testing.T, report HealthReport, name string) Check {
	t.Helper()
	for _, c := range report.Checks {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("check %q not found in report", name)
	return Check{}
}

// requireHealthy 断言报告全部子项 OK 且整体 healthy。
func requireHealthy(t *testing.T, report HealthReport) {
	t.Helper()
	for _, c := range report.Checks {
		if !c.OK {
			t.Fatalf("check %q failed: %s", c.Name, c.Detail)
		}
	}
	if !report.Healthy {
		t.Fatalf("report should be healthy, checks: %+v", report.Checks)
	}
}

// --- CheckEnvironment 用例 ---

func TestCheckEnvironmentAllOK(t *testing.T) {
	chdirToRuntime(t, map[string]string{"t3.json": `{"tenantId":"t3"}`})
	setBothKeys(t)

	report := CheckEnvironment()
	requireHealthy(t, report)

	// 红线：Detail 不得输出密钥值。
	for _, c := range report.Checks {
		if strings.Contains(c.Detail, "test-key-3") || strings.Contains(c.Detail, "test-key-4") {
			t.Fatalf("check %q leaked key value in detail: %q", c.Name, c.Detail)
		}
	}
}

func TestCheckEnvironmentTwoValidConfigs(t *testing.T) {
	chdirToRuntime(t, map[string]string{
		"t3.json": `{"tenantId":"t3"}`,
		"t4.json": `{"tenantId":"t4"}`,
	})
	setBothKeys(t)

	report := CheckEnvironment()
	requireHealthy(t, report)
	if c := findCheck(t, report, "configs"); !strings.Contains(c.Detail, "2 config file(s)") {
		t.Fatalf("configs detail should count 2 files, got %q", c.Detail)
	}
}

func TestCheckEnvironmentMissingKey3(t *testing.T) {
	chdirToRuntime(t, map[string]string{"t3.json": `{"tenantId":"t3"}`})
	clearEnvKey(t, heroAPIKey3Env)
	t.Setenv(heroAPIKey4Env, "test-key-4")

	report := CheckEnvironment()
	if report.Healthy {
		t.Fatal("report should be unhealthy when ARENA_HERO_API_KEY_3 is missing")
	}
	if c := findCheck(t, report, "env."+heroAPIKey3Env); c.OK {
		t.Fatalf("env check for key 3 should fail, got %+v", c)
	}
	if c := findCheck(t, report, "env."+heroAPIKey4Env); !c.OK {
		t.Fatalf("env check for key 4 should pass, got %+v", c)
	}
}

func TestCheckEnvironmentMissingKey4(t *testing.T) {
	chdirToRuntime(t, map[string]string{"t3.json": `{"tenantId":"t3"}`})
	t.Setenv(heroAPIKey3Env, "test-key-3")
	clearEnvKey(t, heroAPIKey4Env)

	report := CheckEnvironment()
	if report.Healthy {
		t.Fatal("report should be unhealthy when ARENA_HERO_API_KEY_4 is missing")
	}
	if c := findCheck(t, report, "env."+heroAPIKey4Env); c.OK {
		t.Fatalf("env check for key 4 should fail, got %+v", c)
	}
}

func TestCheckEnvironmentEmptyKeyValueCountsAsSet(t *testing.T) {
	// 存在性语义：值为空字符串也算"已设置"（os.LookupEnv 返回 ok=true）。
	chdirToRuntime(t, map[string]string{"t3.json": `{}`})
	t.Setenv(heroAPIKey3Env, "")
	t.Setenv(heroAPIKey4Env, "test-key-4")

	report := CheckEnvironment()
	if c := findCheck(t, report, "env."+heroAPIKey3Env); !c.OK {
		t.Fatalf("empty-but-present key should count as set, got %+v", c)
	}
}

func TestCheckEnvironmentInvalidJSONConfig(t *testing.T) {
	chdirToRuntime(t, map[string]string{"t3.json": `{"tenantId":`})
	setBothKeys(t)

	report := CheckEnvironment()
	if report.Healthy {
		t.Fatal("report should be unhealthy with invalid config JSON")
	}
	if c := findCheck(t, report, "configs"); c.OK {
		t.Fatalf("configs check should fail on invalid JSON, got %+v", c)
	}
}

func TestCheckEnvironmentNoConfigDir(t *testing.T) {
	// 根目录下什么都没有：无 runtime/、无 configs/。
	root := t.TempDir()
	t.Chdir(root)
	setBothKeys(t)

	report := CheckEnvironment()
	if report.Healthy {
		t.Fatal("report should be unhealthy without runtime/configs")
	}
	if c := findCheck(t, report, "configs"); c.OK {
		t.Fatalf("configs check should fail, got %+v", c)
	}
	if c := findCheck(t, report, "runtime.writable"); c.OK {
		t.Fatalf("runtime.writable check should fail without runtime dir, got %+v", c)
	}
}

func TestCheckEnvironmentEmptyConfigDir(t *testing.T) {
	chdirToRuntime(t, nil) // configs 目录存在但无 *.json
	setBothKeys(t)

	report := CheckEnvironment()
	if report.Healthy {
		t.Fatal("report should be unhealthy with no config files")
	}
	if c := findCheck(t, report, "configs"); c.OK {
		t.Fatalf("configs check should fail with no config files, got %+v", c)
	}
}

func TestCheckEnvironmentRuntimePathIsFile(t *testing.T) {
	// runtime/ 是普通文件而非目录 → 可写性检查 fail-closed（Windows 下
	// 用 ACL 造只读目录复杂，用"路径不是目录"等价模拟不可写）。
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "runtime"), []byte("not a dir"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	setBothKeys(t)

	report := CheckEnvironment()
	if report.Healthy {
		t.Fatal("report should be unhealthy when runtime is not a directory")
	}
	if c := findCheck(t, report, "runtime.writable"); c.OK {
		t.Fatalf("runtime.writable check should fail when runtime is a file, got %+v", c)
	}
}

// --- CheckLiveLock 用例 ---

// tenantWithLock 构造 runtime/<tenant>/locks/<tenant>.lock 场景，返回 tenantDir。
func tenantWithLock(t *testing.T, tenant string, setup func(lockPath string)) string {
	t.Helper()
	tenantDir := filepath.Join(t.TempDir(), "runtime", tenant)
	lockPath := filepath.Join(tenantDir, "locks", tenant+".lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if setup != nil {
		setup(lockPath)
	}
	return tenantDir
}

func TestCheckLiveLockNoLockFile(t *testing.T) {
	tenantDir := t.TempDir() // 无 locks/ 子目录
	healthy, detail := CheckLiveLock(tenantDir)
	if !healthy {
		t.Fatalf("expected healthy with no lock file, got %q", detail)
	}
}

func TestCheckLiveLockMissingTenantDir(t *testing.T) {
	// 租户目录整体不存在 → 锁文件必然不存在 → healthy。
	tenantDir := filepath.Join(t.TempDir(), "no-such-tenant")
	healthy, detail := CheckLiveLock(tenantDir)
	if !healthy {
		t.Fatalf("expected healthy when tenant dir missing, got %q", detail)
	}
}

func TestCheckLiveLockLivePID(t *testing.T) {
	// 真实活 PID（当前测试进程）：Unix 上 pidAlive 确证存活；Windows 上
	// 无法探测但锁文件是新建的（age 远小于 windowsStaleAge）→ 活锁。
	tenantDir := tenantWithLock(t, "t3", func(lockPath string) {
		writeLockFile(t, lockPath, os.Getpid(), time.Now(), "t3-live")
	})

	healthy, detail := CheckLiveLock(tenantDir)
	if healthy {
		t.Fatalf("expected unhealthy for own live pid, got %q", detail)
	}
	if !strings.Contains(detail, "live pid") {
		t.Fatalf("detail should mention live pid, got %q", detail)
	}
}

func TestCheckLiveLockStalePID(t *testing.T) {
	// PID=999999（实际不存在）+ 修改时间调旧：Unix 上 pidAlive 确证已死；
	// Windows 上 age 超过 windowsStaleAge → stale 不算活锁 → healthy。
	tenantDir := tenantWithLock(t, "t3", func(lockPath string) {
		writeLockFile(t, lockPath, 999999, time.Now(), "t3-dead")
		ageFile(t, lockPath, windowsStaleAge+time.Hour)
	})

	healthy, detail := CheckLiveLock(tenantDir)
	if !healthy {
		t.Fatalf("expected healthy for stale lock, got %q", detail)
	}
	if !strings.Contains(detail, "stale") {
		t.Fatalf("detail should mention stale lock, got %q", detail)
	}
}

func TestCheckLiveLockCorruptLockFile(t *testing.T) {
	tenantDir := tenantWithLock(t, "t3", func(lockPath string) {
		if err := os.WriteFile(lockPath, []byte("not json"), 0o644); err != nil {
			t.Fatal(err)
		}
	})

	healthy, detail := CheckLiveLock(tenantDir)
	if healthy {
		t.Fatalf("expected unhealthy for corrupt lock file, got %q", detail)
	}
	if !strings.Contains(detail, "unreadable") {
		t.Fatalf("detail should mention unreadable lock, got %q", detail)
	}
}

func TestCheckLiveLockInvalidPID(t *testing.T) {
	// JSON 合法但 pid 非法（0）→ 与 lock.go 一致视为不可读，fail-closed。
	tenantDir := tenantWithLock(t, "t3", func(lockPath string) {
		writeLockFile(t, lockPath, 0, time.Now(), "t3")
	})

	healthy, _ := CheckLiveLock(tenantDir)
	if healthy {
		t.Fatal("expected unhealthy for lock with invalid pid 0")
	}
}

func TestCheckLiveLockLockPathIsDirectory(t *testing.T) {
	// locks/<tenant>.lock 被目录占用 → 无法读取 → fail-closed。
	tenantDir := tenantWithLock(t, "t3", func(lockPath string) {
		if err := os.MkdirAll(lockPath, 0o755); err != nil {
			t.Fatal(err)
		}
	})

	healthy, _ := CheckLiveLock(tenantDir)
	if healthy {
		t.Fatal("expected unhealthy when lock path is a directory")
	}
}
