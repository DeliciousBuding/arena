// Package version 通过 -ldflags 注入构建信息，供所有子命令与 manifest 使用。
package version

// 构建时注入：go build -ldflags "-X github.com/deliciousbuding/arena/internal/version.sha=..."
var (
	// sha 是构建来源 commit 的完整 SHA。
	sha = "unknown"
	// tag 是构建来源的版本标签（无 tag 时为 "unknown"）。
	tag = "unknown"
	// builtAt 是构建时间（UTC RFC3339）。
	builtAt = "unknown"
	// schemaHash 是契约层的黄金 schema 哈希（构建时注入，未注入时为 unknown）。
	schemaHash = "unknown"
)

// Info 返回构建信息的不可变快照。
func Info() InfoSnapshot {
	return InfoSnapshot{SHA: sha, Tag: tag, BuiltAt: builtAt, SchemaHash: schemaHash}
}

// InfoSnapshot 是 version.Info 的返回值；字段不可变。
type InfoSnapshot struct {
	SHA        string
	Tag        string
	BuiltAt    string
	SchemaHash string
}

// ShortSHA 返回前 12 位 SHA（日志/遥测用，避免整串噪音）。
func (i InfoSnapshot) ShortSHA() string {
	if len(i.SHA) <= 12 {
		return i.SHA
	}
	return i.SHA[:12]
}
