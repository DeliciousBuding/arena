package llm

import "testing"

func TestModelValidate(t *testing.T) {
	t.Parallel()
	valid := Model{
		Provider:  "newapi",
		ID:        "gpt-4o-mini",
		BaseURL:   "http://127.0.0.1:8120/v1",
		MaxTokens: 4096,
		Compat:    "openai-completions",
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("合法模型被拒: %v", err)
	}
	if err := (Model{Provider: "fake", BaseURL: "http://x"}).Validate(); err == nil {
		t.Fatal("缺少 ID 应报错")
	}
	if err := (Model{Provider: "fake", ID: "m"}).Validate(); err == nil {
		t.Fatal("缺少 BaseURL 应报错")
	}
}
