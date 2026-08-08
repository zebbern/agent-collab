A full-suite run crashed a worker: EPERM rename
`...state.json.<pid>.<uuid>.tmp -> ...state.json`, right after two workers
printed `Warning: state lock ... busy for 5000ms; proceeding without it.`;
Windows, in the state serialization test.

Fix the underlying defect in this repository. Run the relevant existing tests
to check your work.
