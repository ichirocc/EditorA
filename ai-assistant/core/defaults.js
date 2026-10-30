/**
 * The repository the assistant works on until the user enters another one:
 * this project's own. Owner, name and branch can be changed in the settings;
 * the GitHub token never has a default.
 */
export const DEFAULT_REPOSITORY = Object.freeze({
	owner: "ichirocc",
	repo: "EditorA",
	baseBranch: "main",
});

/**
 * Fills the repository fields left empty (earlier versions saved "" before
 * they were entered) with the default repository.
 * @template {{owner?:string, repo?:string, baseBranch?:string}} T
 * @param {T} settings
 * @returns {T}
 */
export function withDefaultRepository(settings) {
	return {
		...settings,
		owner: settings.owner || DEFAULT_REPOSITORY.owner,
		repo: settings.repo || DEFAULT_REPOSITORY.repo,
		baseBranch: settings.baseBranch || DEFAULT_REPOSITORY.baseBranch,
	};
}
