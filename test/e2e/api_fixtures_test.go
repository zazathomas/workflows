package e2e

import (
	"os"
	"testing"
)

// These files are loaded at runtime by the retained API suite and benchmark.
func TestAPIFixturesExist(t *testing.T) {
	paths := []string{
		"testdata/github-webhook-payload.json",
		"testdata/argo-server-test-role.yaml",
		"testdata/artifact-passing-workflow.yaml",
		"testdata/artifact-workflow-stopped.yaml",
		"testdata/artifact-workflow.yaml",
		"testdata/retry-on-stopped.yaml",
		"smoke/basic.yaml",
		"smoke/workflow-template-whalesay-template.yaml",
		"benchmarks/multiple-ref-echo-1-workflowtemplate.yaml",
		"benchmarks/multiple-ref-echo-2-workflowtemplate.yaml",
		"benchmarks/multiple-ref-main-workflowtemplate.yaml",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("API fixture missing: %v", err)
			}
		})
	}
}
