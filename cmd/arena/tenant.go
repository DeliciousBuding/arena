package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/hero"
	"github.com/deliciousbuding/arena/internal/ops"
	"github.com/deliciousbuding/arena/internal/runtime"
	"github.com/deliciousbuding/arena/internal/strategy"
	"github.com/deliciousbuding/arena/internal/telemetry"
)

// tenantConfigFile 是租户配置文件的 JSON 结构（只含 env 名，不含密钥值）。
type tenantConfigFile struct {
	TenantID      string `json:"tenantId"`
	ArenaTokenEnv string `json:"arenaTokenEnv"`
	DecisionMode  string `json:"decisionMode"`
	SubmitEnabled bool   `json:"submitEnabled"`
	BaseURL       string `json:"baseUrl,omitempty"`
	Model         struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	} `json:"model"`
	BaseDir string `json:"baseDir"`
}

func runTenantCmd(args []string) int {
	fs := flag.NewFlagSet("tenant", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	configPath := fs.String("config", "", "tenant config JSON path")
	shadow := fs.Bool("shadow", false, "observe only, never submit")
	live := fs.Bool("live", false, "submit real plans (requires explicit approval)")
	maxTicks := fs.Int("max-ticks", 0, "stop after N processed ticks (0 = unlimited)")
	baseURL := fs.String("base-url", "", "override game server base URL")
	debug := fs.Bool("debug", false, "enable debug logging (per-tick and reconnect)")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}
	if *configPath == "" {
		fmt.Fprintln(os.Stderr, "arena tenant: --config is required")
		return exitConfig
	}
	if *shadow && *live {
		fmt.Fprintln(os.Stderr, "arena tenant: --shadow and --live are mutually exclusive")
		return exitConfig
	}

	configFile, err := loadTenantConfig(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "arena tenant: config: %v\n", err)
		return exitConfig
	}
	submissionMode := runtime.ModeShadow
	if *live {
		// live 双确认：--live flag 与配置 submitEnabled=true 必须同时成立，
		// 防止误传 flag 或配置漂移导致意外提交。
		if !configFile.SubmitEnabled {
			fmt.Fprintln(os.Stderr, "arena tenant: --live requires submitEnabled=true in config (double confirmation)")
			return exitConfig
		}
		submissionMode = runtime.ModeLive
	}

	apiKey := os.Getenv(configFile.ArenaTokenEnv)
	if apiKey == "" {
		fmt.Fprintf(os.Stderr, "arena tenant: env %s is not set (token must come from environment)\n", configFile.ArenaTokenEnv)
		return exitConfig
	}

	logLevel := slog.LevelInfo
	if *debug {
		logLevel = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel}))

	// 遥测与 manifest（baseDir 下 tenant 目录，gitignored）。
	baseDir := configFile.BaseDir
	if baseDir == "" {
		baseDir = "runtime"
	}
	tenantDir := filepath.Join(baseDir, configFile.TenantID)

	// live 单写者锁：同租户只能一个 live writer，拿不到锁直接失败退出。
	// stale 锁只报告不自动清理（红线：不自动删除；operator 显式处理）。
	var liveLock *ops.Lock
	if submissionMode == runtime.ModeLive {
		lockDir := filepath.Join(tenantDir, "locks")
		if err := os.MkdirAll(lockDir, 0o700); err != nil {
			fmt.Fprintf(os.Stderr, "arena tenant: create lock dir: %v\n", err)
			return exitError
		}
		lockPath := filepath.Join(lockDir, configFile.TenantID+".lock")
		lock, err := ops.New().Acquire(lockPath, configFile.TenantID+"-live")
		if err != nil {
			fmt.Fprintf(os.Stderr, "arena tenant: single-writer lock: %v (tenant %s already has a live writer; stale locks are NOT auto-removed)\n", err, configFile.TenantID)
			return exitError
		}
		liveLock = lock
		defer func() { _ = liveLock.Release() }()
		logger.Info("live lock acquired", "path", lockPath)
	}

	runID := fmt.Sprintf("run-%s", time.Now().UTC().Format("20060102T150405"))
	runDir := filepath.Join(tenantDir, "runs", runID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "arena tenant: create run dir: %v\n", err)
		return exitError
	}

	heroConfig := hero.DefaultConfig(apiKey)
	heroConfig.Logger = logger
	if *baseURL != "" {
		heroConfig.BaseURL = *baseURL
	}
	if configFile.BaseURL != "" && *baseURL == "" {
		heroConfig.BaseURL = configFile.BaseURL
	}
	client, err := hero.NewClient(heroConfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "arena tenant: %v\n", err)
		return exitConfig
	}

	// 遥测与 manifest 按 run 隔离写入（run-scoped telemetry）：
	// runtime/<tenant>/runs/<run-id>/{runtime,decision}.jsonl + manifest.json。
	// 跨运行不再 append 同一文件（避免 tick 赛马数据污染）。
	runtimeLog, err := telemetry.Open(filepath.Join(runDir, "runtime.jsonl"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "arena tenant: open runtime log: %v\n", err)
		return exitError
	}
	decisionLog, err := telemetry.Open(filepath.Join(runDir, "decision.jsonl"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "arena tenant: open decision log: %v\n", err)
		return exitError
	}

	manifest, err := telemetry.BuildManifest(telemetry.ManifestOptions{
		TenantID:      configFile.TenantID,
		DecisionMode:  configFile.DecisionMode,
		SubmitEnabled: submissionMode == runtime.ModeLive,
		ModelID:       configFile.Model.ID,
		Provider:      configFile.Model.Provider,
		RulesVersion:  "v0.11",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "arena tenant: build manifest: %v\n", err)
		return exitError
	}
	_ = telemetry.WriteManifest(filepath.Join(runDir, "manifest.json"), manifest)

	loop := &runtime.Loop{
		Client:  client,
		Planner: strategy.NewPlanner(strategy.DefaultConfig()),
		World:   domain.NewWorld(),
		Config: runtime.TenantConfig{
			TenantID:       configFile.TenantID,
			BaseURL:        heroConfig.BaseURL,
			DecisionMode:   configFile.DecisionMode,
			SubmissionMode: submissionMode,
			MaxTicks:       *maxTicks,
		},
		Logger:      logger,
		RuntimeLog:  runtimeLog,
		DecisionLog: decisionLog,
	}
	defer loop.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signalChan := make(chan os.Signal, 1)
	signal.Notify(signalChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signalChan
		logger.Info("shutdown signal received")
		cancel()
	}()

	logger.Info("tenant started",
		"tenant", configFile.TenantID,
		"mode", submissionMode,
		"decisionMode", configFile.DecisionMode,
		"baseUrl", heroConfig.BaseURL,
	)
	if err := loop.Run(ctx); err != nil {
		logger.Error("tenant run failed", "error", err)
		return exitError
	}
	logger.Info("tenant stopped",
		"ticks", loop.Stats.ProcessedTicks.Load(),
		"submits", loop.Stats.LiveSubmits.Load(),
		"rejected", loop.Stats.RejectedSubmits.Load(),
		"repaired", loop.Stats.RepairedPlans.Load(),
	)
	return exitOK
}

func loadTenantConfig(path string) (*tenantConfigFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config tenantConfigFile
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("invalid config JSON: %w", err)
	}
	if config.TenantID == "" || config.ArenaTokenEnv == "" {
		return nil, fmt.Errorf("tenantId and arenaTokenEnv are required")
	}
	if config.DecisionMode == "" {
		config.DecisionMode = "deterministic"
	}
	return &config, nil
}
