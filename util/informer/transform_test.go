package informer

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	apiv1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/cache"
)

func TestStripManagedFields(t *testing.T) {
	t.Run("typed object", func(t *testing.T) {
		pod := &apiv1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:          "my-pod",
				ManagedFields: []metav1.ManagedFieldsEntry{{Manager: "kubelet"}},
			},
		}
		out, err := StripManagedFields(pod)
		require.NoError(t, err)
		assert.Same(t, pod, out)
		assert.Nil(t, pod.ManagedFields)
		assert.Equal(t, "my-pod", pod.Name)
	})
	t.Run("unstructured object", func(t *testing.T) {
		un := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Workflow",
			"metadata": map[string]any{
				"name":          "my-wf",
				"managedFields": []any{map[string]any{"manager": "workflow-controller"}},
			},
		}}
		out, err := StripManagedFields(un)
		require.NoError(t, err)
		assert.Same(t, un, out)
		assert.Nil(t, un.GetManagedFields())
		assert.NotContains(t, un.Object["metadata"], "managedFields")
		assert.Equal(t, "my-wf", un.GetName())
	})
	t.Run("nil managedFields is not mutated", func(t *testing.T) {
		un := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Workflow",
			"metadata":   map[string]any{"name": "my-wf"},
		}}
		want := un.DeepCopy()
		out, err := StripManagedFields(un)
		require.NoError(t, err)
		assert.Same(t, un, out)
		assert.Equal(t, want, un)
	})
	t.Run("non-object input passes through", func(t *testing.T) {
		tombstone := cache.DeletedFinalStateUnknown{Key: "my-ns/my-pod"}
		out, err := StripManagedFields(tombstone)
		require.NoError(t, err)
		assert.Equal(t, tombstone, out)
	})
}

func TestTrimManagedFields(t *testing.T) {
	t.Run("keeps the audit fields and drops the field sets", func(t *testing.T) {
		at := metav1.NewTime(time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC))
		un := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "WorkflowTemplate",
			"metadata": map[string]any{
				"name": "my-wf",
				"managedFields": []any{map[string]any{
					"manager":    "argo-server",
					"operation":  "Update",
					"apiVersion": "argoproj.io/v1alpha1",
					"time":       "2025-01-02T03:04:05Z",
					"fieldsType": "FieldsV1",
					"fieldsV1":   map[string]any{"f:spec": map[string]any{"f:templates": map[string]any{}}},
				}},
			},
		}}
		out, err := TrimManagedFields(un)
		require.NoError(t, err)
		assert.Same(t, un, out)
		assert.Equal(t, "my-wf", un.GetName())
		entries := un.GetManagedFields()
		require.Len(t, entries, 1)
		assert.Equal(t, "argo-server", entries[0].Manager)
		assert.Equal(t, metav1.ManagedFieldsOperationUpdate, entries[0].Operation)
		require.NotNil(t, entries[0].Time)
		assert.True(t, entries[0].Time.Equal(&at))
		assert.Nil(t, entries[0].FieldsV1)
		assert.NotContains(t, un.Object["metadata"].(map[string]any)["managedFields"].([]any)[0].(map[string]any), "fieldsV1")
	})
	t.Run("keeps the most recent editors", func(t *testing.T) {
		base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
		var entries []metav1.ManagedFieldsEntry
		for i := range maxManagedFieldEntries + 5 {
			at := metav1.NewTime(base.Add(time.Duration(i) * time.Minute))
			entries = append(entries, metav1.ManagedFieldsEntry{Manager: fmt.Sprintf("editor-%d", i), Time: &at})
		}
		// Newest first in the input; the transform must not depend on order.
		for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
			entries[i], entries[j] = entries[j], entries[i]
		}
		pod := &apiv1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "my-pod", ManagedFields: entries}}
		_, err := TrimManagedFields(pod)
		require.NoError(t, err)
		require.Len(t, pod.ManagedFields, maxManagedFieldEntries)
		assert.Equal(t, "editor-5", pod.ManagedFields[0].Manager)
		assert.Equal(t, fmt.Sprintf("editor-%d", maxManagedFieldEntries+4), pod.ManagedFields[len(pod.ManagedFields)-1].Manager)
	})
	t.Run("nil managedFields is not mutated", func(t *testing.T) {
		un := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Workflow",
			"metadata":   map[string]any{"name": "my-wf"},
		}}
		want := un.DeepCopy()
		out, err := TrimManagedFields(un)
		require.NoError(t, err)
		assert.Same(t, un, out)
		assert.Equal(t, want, un)
	})
	t.Run("non-object input passes through", func(t *testing.T) {
		tombstone := cache.DeletedFinalStateUnknown{Key: "my-ns/my-pod"}
		out, err := TrimManagedFields(tombstone)
		require.NoError(t, err)
		assert.Equal(t, tombstone, out)
	})
}
