// arena 是 Arena 的单一入口二进制：supervisor / tenant / doctor / replay / version。
//
// 子命令划分（与 docs/go/01-architecture.md 一致）：
//
//	supervisor   多租户进程管理（preflight → spawn → health/ready → 优雅关闭）
//	tenant       单租户运行循环（turns → 决策 → 提交）
//	doctor       环境/配置/密钥/连接自检
//	replay       fixture 回放（对等验证工具）
//	version      构建信息
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/deliciousbuding/arena/internal/version"
)

// exit codes（与主线 run-tenant 语义对齐）：
// 0 成功；1 运行错误；64 doctor 失败；78 配置错误（systemd RestartPreventExitStatus）。
const (
	exitOK     = 0
	exitError  = 1
	exitDoctor = 64
	exitConfig = 78
)

var subcommands = map[string]bool{
	"supervisor": true,
	"tenant":     true,
	"doctor":     true,
	"replay":     true,
	"version":    true,
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage()
		return exitConfig
	}
	name := args[0]
	if !subcommands[name] {
		fmt.Fprintf(os.Stderr, "arena: unknown subcommand %q\n\n", name)
		usage()
		return exitConfig
	}

	switch name {
	case "version":
		return runVersion(args[1:])
	case "tenant":
		return runTenantCmd(args[1:])
	case "replay":
		return runReplayCmd(args[1:])
	default:
		// 后续批次实现；当前给出明确未实现提示（不静默成功）。
		fmt.Fprintf(os.Stderr, "arena: %s not implemented yet (see docs/go/05-delivery-plan.md)\n", name)
		return exitError
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `usage: arena <subcommand> [flags]

subcommands:
  supervisor   run the multi-tenant supervisor
  tenant       run a single-tenant decision loop
  doctor       run environment preflight checks
  replay       replay golden fixtures (parity verification)
  version      print build information
`)
}

func runVersion(args []string) int {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}
	info := version.Info()
	fmt.Printf("arena %s (sha %s, built %s, schema %s)\n",
		info.Tag, info.ShortSHA(), info.BuiltAt, info.SchemaHash)
	return exitOK
}
