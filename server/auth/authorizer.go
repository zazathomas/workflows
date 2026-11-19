package auth

import (
	"context"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	authUtil "github.com/argoproj/argo-workflows/v4/util/auth"
)

// CanUseExtension checks an action grant without giving the caller access to the records or credentials behind it.
func CanUseExtension(ctx context.Context, verb, resource, namespace, name string) (bool, error) {
	review, err := GetKubeClient(ctx).AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
			Group: "platform.argoproj.io", Verb: verb, Resource: resource, Namespace: namespace, Name: name,
		}},
	}, metav1.CreateOptions{})
	return err == nil && review.Status.Allowed && !review.Status.Denied && review.Status.EvaluationError == "", err
}

func CanI(ctx context.Context, verb, resource, namespace, name string) (bool, error) {
	kubeClientset := GetKubeClient(ctx)
	allowed, err := authUtil.CanIArgo(ctx, kubeClientset, verb, resource, namespace, name)
	if err != nil {
		return false, err
	}
	return allowed, nil
}
