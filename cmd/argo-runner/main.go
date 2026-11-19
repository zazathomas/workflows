// Command argo-runner runs workflow steps on a remote host for an argo-server
// with the runner extension enabled (docs/runners.md).
package main

import (
	"os"

	"github.com/argoproj/argo-workflows/v4/cmd/argo-runner/commands"
)

func main() {
	if err := commands.NewCommand().Execute(); err != nil {
		os.Exit(1)
	}
}
