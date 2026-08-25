# CI setup

The workflow checks out one repository containing the installer and all module
sources. It does not initialize external repositories and needs no
cross-repository token.

The clean-clone job installs each module's declared dependencies, runs the
bundle boundary check, validates all module contracts, executes the internal
planner-to-worker, review and documentation gates, and builds/tests the
control runtime.

The control module currently targets .NET 9, so the workflow installs the .NET
9 SDK before running its tests.

The control module currently targets .NET 9, so the workflow installs the .NET
9 SDK before running its tests.
