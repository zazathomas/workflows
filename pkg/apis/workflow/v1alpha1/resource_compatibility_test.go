package v1alpha1

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/runtime"
)

func TestStableWorkflowResourceKinds(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, AddToScheme(scheme))
	require.Equal(t, "argoproj.io", SchemeGroupVersion.Group)
	require.Equal(t, "v1alpha1", SchemeGroupVersion.Version)
	for _, kind := range []string{
		"Workflow", "WorkflowTemplate", "ClusterWorkflowTemplate", "CronWorkflow",
		"WorkflowEventBinding", "WorkflowTaskResult", "WorkflowTaskSet", "WorkflowArtifactGCTask",
	} {
		t.Run(kind, func(t *testing.T) {
			_, err := scheme.New(SchemeGroupVersion.WithKind(kind))
			require.NoError(t, err)
			_, err = scheme.New(SchemeGroupVersion.WithKind(kind + "List"))
			require.NoError(t, err)
		})
	}
}
