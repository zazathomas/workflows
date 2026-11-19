package api

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// MintJoinToken creates a single-use join-token Secret in namespace and
// returns the token (shown exactly once) and the Secret name. It is the one
// implementation used by the admin API and by `argo-runner admin
// create-join-token`, so both validate the pool reference and the pool's
// existence the same way.
func MintJoinToken(ctx context.Context, kube kubernetes.Interface, namespace, pool string, ttl time.Duration, now time.Time) (token string, name string, err error) {
	if ttl <= 0 || ttl > time.Hour {
		return "", "", fmt.Errorf("join token ttl must be between 1s and 1h, got %s", ttl)
	}
	ref, err := ParsePoolRef(pool)
	if err != nil {
		return "", "", err
	}
	poolNamespace := ref.Namespace
	if poolNamespace == "" {
		poolNamespace = namespace
	}
	// A token for a pool that does not exist can never be redeemed: refuse it
	// up front instead of burning it at enrolment.
	if _, err := kube.CoreV1().ConfigMaps(poolNamespace).Get(ctx, PoolConfigMapName(ref.Name), metav1.GetOptions{}); err != nil {
		if apierrors.IsNotFound(err) {
			return "", "", fmt.Errorf("pool %q does not exist in namespace %q", ref, poolNamespace)
		}
		return "", "", fmt.Errorf("checking pool %q: %w", ref, err)
	}
	token = "ajt_" + RandomHex(32)
	secretName := JoinTokenSecretName(RandomHex(8))
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: namespace,
			Labels: map[string]string{
				LabelComponent: ComponentJoinToken,
			},
			Annotations: map[string]string{
				AnnotationPool:      pool,
				AnnotationTokenHash: HashToken(token),
				AnnotationExpiresAt: now.Add(ttl).UTC().Format(time.RFC3339),
			},
		},
	}
	if _, err := kube.CoreV1().Secrets(namespace).Create(ctx, secret, metav1.CreateOptions{}); err != nil {
		return "", "", fmt.Errorf("creating join token secret: %w", err)
	}
	return token, secretName, nil
}
