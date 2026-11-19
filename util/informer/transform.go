// Package informer provides helpers shared by the informers used in the
// workflow-controller and argo-server.
package informer

import (
	"sort"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// maxManagedFieldEntries bounds the change history kept by TrimManagedFields.
const maxManagedFieldEntries = 20

// StripManagedFields is a cache.TransformFunc that removes
// metadata.managedFields before objects enter an informer cache.
// Nothing reads managedFields from the cache, and the API server ignores
// a nil managedFields on non-apply updates, so this is loss-free. It can
// be 20% or more of the object size.
func StripManagedFields(i any) (any, error) {
	obj, err := meta.Accessor(i)
	// err != nil: tombstones (DeletedFinalStateUnknown) etc — pass through.
	// The nil-check avoids mutating objects that already lack managedFields
	// (kubernetes/kubernetes#124337).
	if err == nil && obj.GetManagedFields() != nil {
		obj.SetManagedFields(nil)
	}
	return i, nil
}

// TrimManagedFields is a cache.TransformFunc that keeps the audit-relevant
// parts of metadata.managedFields and drops the per-field sets, which are the
// reason the field can be 20% or more of an object.
//
// argo-server serves templates from an informer, and the UI derives its
// "Changes" tab from managedFields. The controller strips the whole field
// because it never reads it; the server keeps manager, operation, subresource
// and time so the UI can say who changed an object, how, and when. The API
// server rebuilds managedFields from the live object on update, so partial
// entries are safe.
func TrimManagedFields(i any) (any, error) {
	obj, err := meta.Accessor(i)
	if err != nil {
		// tombstones (DeletedFinalStateUnknown) etc — pass through
		return i, nil
	}
	entries := obj.GetManagedFields()
	if entries == nil {
		return i, nil
	}
	trimmed := make([]metav1.ManagedFieldsEntry, 0, min(len(entries), maxManagedFieldEntries))
	for _, entry := range entries {
		entry.FieldsV1 = nil
		trimmed = append(trimmed, entry)
	}
	if len(trimmed) > maxManagedFieldEntries {
		// Keep the most recent editors; entries without a time sort first.
		sort.SliceStable(trimmed, func(a, b int) bool {
			return timeOf(trimmed[a]).Before(timeOf(trimmed[b]))
		})
		trimmed = trimmed[len(trimmed)-maxManagedFieldEntries:]
	}
	obj.SetManagedFields(trimmed)
	return i, nil
}

func timeOf(entry metav1.ManagedFieldsEntry) time.Time {
	if entry.Time == nil {
		return time.Time{}
	}
	return entry.Time.Time
}
