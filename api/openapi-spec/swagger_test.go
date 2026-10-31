package openapi_spec //nolint:staticcheck

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

type obj = map[string]any

func TestSwagger(t *testing.T) {
	swagger := obj{}
	data, err := os.ReadFile("swagger.json")
	if err != nil {
		panic(err)
	}
	err = json.Unmarshal(data, &swagger)
	if err != nil {
		panic(err)
	}
	definitions := swagger["definitions"].(obj)
	paths := swagger["paths"].(obj)

	// These routes are consumed by the CLI, generated SDKs, and existing
	// automation. Keep this list additive when introducing fork-specific APIs.
	expectedPaths := map[string][]string{
		"/api/v1/info":                             {"get"},
		"/api/v1/version":                          {"get"},
		"/api/v1/userinfo":                         {"get"},
		"/api/v1/workflows/{namespace}":            {"get", "post"},
		"/api/v1/workflows/{namespace}/{name}":     {"delete", "get"},
		"/api/v1/workflows/{namespace}/{name}/log": {"get"},
		"/api/v1/workflow-templates/{namespace}":   {"get", "post"},
		"/api/v1/cluster-workflow-templates":       {"get", "post"},
		"/api/v1/archived-workflows":               {"get"},
	}
	for path, methods := range expectedPaths {
		path, methods := path, methods
		t.Run("route "+path, func(t *testing.T) {
			definition, ok := paths[path].(obj)
			if assert.True(t, ok, "stable API route must remain in the OpenAPI document") {
				for _, method := range methods {
					assert.Contains(t, definition, method)
				}
			}
		})
	}
	// one definition from each API
	t.Run("io.argoproj.workflow.v1alpha1.CreateCronWorkflowRequest", func(t *testing.T) {
		assert.Contains(t, definitions, "io.argoproj.workflow.v1alpha1.CreateCronWorkflowRequest")
	})
	t.Run("io.argoproj.workflow.v1alpha1.WorkflowCreateRequest", func(t *testing.T) {
		assert.Contains(t, definitions, "io.argoproj.workflow.v1alpha1.WorkflowCreateRequest")
	})
	t.Run("io.argoproj.workflow.v1alpha1.ClusterWorkflowTemplateCreateRequest", func(t *testing.T) {
		assert.Contains(t, definitions, "io.argoproj.workflow.v1alpha1.ClusterWorkflowTemplateCreateRequest")
	})
	t.Run("io.argoproj.workflow.v1alpha1.WorkflowTemplateCreateRequest", func(t *testing.T) {
		assert.Contains(t, definitions, "io.argoproj.workflow.v1alpha1.WorkflowTemplateCreateRequest")
	})
	t.Run("io.argoproj.workflow.v1alpha1.InfoResponse", func(t *testing.T) {
		assert.Contains(t, definitions, "io.argoproj.workflow.v1alpha1.InfoResponse")
	})
	t.Run("io.argoproj.workflow.v1alpha1.ScriptTemplate", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.ScriptTemplate"].(obj)
		assert.NotContains(t, definition["required"], "name")
	})
	t.Run("io.argoproj.workflow.v1alpha1.CronWorkflow", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.CronWorkflow"].(obj)
		assert.NotContains(t, definition["required"], "status")
	})
	t.Run("io.argoproj.workflow.v1alpha1.Workflow", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.Workflow"].(obj)
		assert.NotContains(t, definition["required"], "status")
	})
	t.Run("io.argoproj.workflow.v1alpha1.Parameter", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.Parameter"].(obj)
		properties := definition["properties"].(obj)
		assert.Equal(t, "string", properties["default"].(obj)["type"])
		assert.Equal(t, "string", properties["value"].(obj)["type"])
	})
	t.Run("io.argoproj.workflow.v1alpha1.Histogram", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.Histogram"].(obj)
		buckets := definition["properties"].(obj)["buckets"].(obj)
		assert.Equal(t, "array", buckets["type"])
		assert.Equal(t, obj{"$ref": "#/definitions/io.argoproj.workflow.v1alpha1.Amount"}, buckets["items"])
	})
	t.Run("io.argoproj.workflow.v1alpha1.Amount", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.Amount"].(obj)
		assert.Equal(t, "number", definition["type"])
	})
	t.Run("io.argoproj.workflow.v1alpha1.Item", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.Item"].(obj)
		assert.Empty(t, definition["type"])
	})
	t.Run("io.argoproj.workflow.v1alpha1.ParallelSteps", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.ParallelSteps"].(obj)
		assert.Equal(t, "array", definition["type"])
		assert.Equal(t, obj{"$ref": "#/definitions/io.argoproj.workflow.v1alpha1.WorkflowStep"}, definition["items"])
	})
	// this test makes sure we deal with `inline`
	t.Run("io.argoproj.workflow.v1alpha1.UserContainer", func(t *testing.T) {
		definition := definitions["io.argoproj.workflow.v1alpha1.UserContainer"].(obj)
		properties := definition["properties"]
		assert.Contains(t, properties, "image")
	})
	// yes - we actually delete this field
	t.Run("io.k8s.api.core.v1.Container", func(t *testing.T) {
		definition := definitions["io.k8s.api.core.v1.Container"].(obj)
		required := definition["required"]
		assert.Contains(t, required, "image")
		assert.NotContains(t, required, "name")
	})
	// this test makes sure we can deal with an instance where we are wrong vs Kubernetes
	t.Run("io.k8s.api.core.v1.SecretKeySelector", func(t *testing.T) {
		definition := definitions["io.k8s.api.core.v1.SecretKeySelector"].(obj)
		properties := definition["properties"]
		assert.Contains(t, properties, "name")
	})
	// this test makes sure we can deal with an instance where we are wrong vs Kubernetes
	t.Run("io.k8s.api.core.v1.Volume", func(t *testing.T) {
		definition := definitions["io.k8s.api.core.v1.Volume"].(obj)
		properties := definition["properties"]
		assert.Contains(t, properties, "name")
		assert.NotContains(t, properties, "volumeSource")
	})
}
