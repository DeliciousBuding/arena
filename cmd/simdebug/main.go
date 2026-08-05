// simdebug：临时诊断工具——单场景跑 N tick，定期 dump 每个单位
// 的位置/货仓/HP + 意图，定位经济冻结（工人不去采/回仓被堵等）。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
	"github.com/deliciousbuding/arena/internal/strategy"
)

type tickStateJSON struct {
	Tick             int                   `json:"tick"`
	Status           string                `json:"status"`
	Resources        int                   `json:"resources"`
	ResourceCapacity int                   `json:"resourceCapacity"`
	ResourceSpace    int                   `json:"resourceSpace"`
	Population       int                   `json:"population"`
	Core             *domain.Core          `json:"core"`
	Units            []domain.UnitSnapshot `json:"units"`
	Workers          []domain.UnitSnapshot `json:"workers"`
	Vanguards        []domain.UnitSnapshot `json:"vanguards"`
	Rangers          []domain.UnitSnapshot `json:"rangers"`
	ResourceCells    []string              `json:"resourceCells"`
	ObstacleCells    []string              `json:"obstacleCells"`
	Beacon           domain.Beacon         `json:"beacon"`
}

func (t *tickStateJSON) toTickState() *domain.TickState {
	return &domain.TickState{
		Tick:             t.Tick,
		Status:           domain.PlayerStatus(t.Status),
		Resources:        t.Resources,
		ResourceCapacity: t.ResourceCapacity,
		ResourceSpace:    t.ResourceSpace,
		Population:       t.Population,
		Core:             t.Core,
		Units:            t.Units,
		Workers:          t.Workers,
		Vanguards:        t.Vanguards,
		Rangers:          t.Rangers,
		ResourceCells:    domain.NewSet(t.ResourceCells...),
		ObstacleCells:    domain.NewSet(t.ObstacleCells...),
		Beacon:           t.Beacon,
	}
}

type sceneFile struct {
	Name            string            `json:"name"`
	Initial         *tickStateJSON    `json:"initial"`
	LatentResources []domain.Position `json:"latentResources"`
}

func main() {
	scenePath := flag.String("scene", "runtime/scenes/base.json", "scene JSON")
	policyName := flag.String("policy", "default", "policy: default|aggressive|growth")
	ticks := flag.Int("ticks", 100, "ticks")
	dumpEvery := flag.Int("dump", 25, "dump interval")
	flag.Parse()

	data, err := os.ReadFile(*scenePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read scene: %v\n", err)
		os.Exit(1)
	}
	var file sceneFile
	if err := json.Unmarshal(data, &file); err != nil {
		fmt.Fprintf(os.Stderr, "parse scene: %v\n", err)
		os.Exit(1)
	}
	state := file.Initial.toTickState()
	config := strategy.DefaultConfig()
	config.Name = *policyName
	planner := strategy.NewPlanner(config)
	engine := sim.NewEngine()
	engine.Refill = sim.NewRefillConfig(file.LatentResources)

	for tick := 1; tick <= *ticks; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		settled := engine.Settle(state, plan)
		if tick%*dumpEvery == 0 || tick == *ticks {
			next := settled.NextState
			fmt.Printf("\n=== t%d res=%d space=%d cells=%d workers=%d blocked=%d ===\n",
				tick, next.Resources, next.ResourceSpace, len(next.ResourceCells), len(next.Workers), settled.Stats.Blocked)
			for _, unit := range next.Units {
				intent := plan.Intents[unit.ID]
				if intent == "" {
					intent = "-"
				}
				action := plan.UnitActions[unit.ID]
				actionKind := string(action.Kind)
				if actionKind == "" {
					actionKind = "-"
				}
				detail := ""
				if action.Direction != nil {
					target := domain.Move(unit.Position, *action.Direction)
					detail = fmt.Sprintf("→(%d,%d)", target[0], target[1])
				}
				fmt.Printf("  %-12s %-8s at(%d,%d) cargo=%d hp=%d intent=%-16s action=%s%s\n",
					unit.ID, unit.UnitType, unit.Position[0], unit.Position[1], unit.Cargo, unit.HP, intent, actionKind, detail)
			}
		}
		state = settled.NextState
	}
}
