package repopolicy

#RepoPolicy & {
	defaultBranch: "main"
	merge: {
		rebase: true
		merge: false
		squash: false
		deleteBranchOnMerge: true
		autoMerge: false
	}
	// PR-only merges are specified in .github/main-ruleset.json; Shaka's
	// current branch-protection fixer cannot preserve that requirement.
	branchProtection: {
		requiredChecks: [
			"Gate",
			"Validate (ubuntu-24.04, Node 24)",
			"Validate (ubuntu-24.04, Node 22)",
			"Validate (macos-15, Node 24)",
		]
		strictStatusChecks: true
		allowForcePush: false
		allowDeletion: false
	}
	rulesets: {
		requireDeletion: true
		requireNonFastForward: true
		requireStatusChecks: true
	}
	handAuthoredWorkflows: ["ci.yml"]
}
