package notify

import (
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEmptyHostPolicyRejectsBothTransports(t *testing.T) {
	target, err := url.Parse("https://example.invalid")
	require.NoError(t, err)
	s := sender{transport: Transport{Host: target.Hostname()}}
	require.ErrorContains(t, s.validateHTTPURL(target), "not allowlisted")
	require.ErrorContains(t, s.sendSMTP(t.Context(), Delivery{}), "not allowlisted")
}
