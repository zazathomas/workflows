package commands

import (
	"github.com/spf13/cobra"

	"github.com/argoproj/argo-workflows/v4"
	cmdutil "github.com/argoproj/argo-workflows/v4/util/cmd"
)

const (
	// CLIName is the name of this CLI.
	CLIName = "argo-runner"
)

// NewCommand returns the argo-runner root command.
func NewCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   CLIName,
		Short: "run Argo Workflows steps on a remote host",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	command.AddCommand(newEnrolCommand())
	command.AddCommand(newRunCommand())
	command.AddCommand(newRotateCommand())
	command.AddCommand(newGateCommand())
	command.AddCommand(newVersionCommand())
	return command
}

func newVersionCommand() *cobra.Command {
	short := false
	command := &cobra.Command{
		Use:   "version",
		Short: "print version information",
		RunE: func(cmd *cobra.Command, args []string) error {
			cmdutil.PrintVersion(CLIName, argo.GetVersion(), short)
			return nil
		},
	}
	command.Flags().BoolVar(&short, "short", false, "print just the version number")
	return command
}
