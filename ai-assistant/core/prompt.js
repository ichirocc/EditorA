/** Where the assistant runs, unless the host app says otherwise. */
export const DEFAULT_HOST =
	"EditorA AI Assistant, a chat app the user opens in a browser, often on a phone";

/**
 * System prompt for an assistant session. It only depends on values fixed
 * for the whole session, so it stays byte-identical and cacheable; changing
 * state reaches the model through <app_state> notes in user messages.
 * @param {{owner:string, repo:string, baseBranch:string, host?:string}} target
 *   `host` describes the app the assistant runs in
 * @returns {string}
 */
export function buildSystemPrompt({
	owner,
	repo,
	baseBranch,
	host = DEFAULT_HOST,
}) {
	return `You are a coding assistant inside ${host}. You work on the GitHub repository ${owner}/${repo}, starting from its "${baseBranch}" branch.

How this works:
- You read the repository and stage edits with your tools. Nothing leaves the app until the user reviews the diff and presses Push, which commits your staged edits to a work branch. The user then opens a pull request and merges it into ${baseBranch} from the app. You cannot push, open pull requests or merge; when the user asks for that, tell them which button to use.
- For a new request, read the relevant files first. If the change is non-trivial or the request is ambiguous, reply with a short plan and wait for the user to agree before editing. Make small, unambiguous fixes directly.
- Keep changes focused and match the surrounding code's style. Do not reformat code you were not asked to change.
- A user message may start with an <app_state> block. The app writes it, not the user. It describes the work branch, staged edits and pull request; trust it over your memory (for example, a file the user reverted is no longer staged).
- If the user reports failing CI checks, find and fix the cause with your tools; the user will push again.
- When the app merges ${baseBranch} into the work branch, files both sides changed in the same place contain conflict markers (<<<<<<<, =======, >>>>>>>). Resolve each one so that both sides' intent is kept where possible and no markers remain.
- The screen is small: keep replies short, show short snippets rather than whole files, and answer in the language the user writes in.`;
}

/**
 * State note prepended to a user message when the state changed.
 * @param {object} state
 * @param {string|null} state.workBranch
 * @param {string[]} state.stagedPaths
 * @param {{number:number, state:string, merged:boolean}|null} state.pr
 * @param {{baseBranch:string, conflicted:string[]}|null} [state.merge]
 * @returns {string}
 */
export function buildStateNote({ workBranch, stagedPaths, pr, merge = null }) {
	const lines = [
		`Work branch: ${workBranch || "not created yet (created on first push)"}`,
		`Staged, not yet pushed: ${stagedPaths.length ? stagedPaths.join(", ") : "nothing"}`,
		`Pull request: ${
			pr ? `#${pr.number} (${pr.merged ? "merged" : pr.state})` : "none"
		}`,
	];
	if (merge) {
		lines.push(
			`Merging ${merge.baseBranch} into the work branch; staged files are relative to the latest ${merge.baseBranch}.`,
			`Unresolved conflict markers: ${
				merge.conflicted.length ? merge.conflicted.join(", ") : "none"
			}`,
		);
	}
	return `<app_state>\n${lines.join("\n")}\n</app_state>`;
}

/**
 * Failed CI checks described for the assistant.
 * @param {{name:string, summary:string, annotations:any[], log:string|null}[]} details
 * @returns {string}
 */
export function buildCiFailureReport(details) {
	return details
		.map(({ name, summary, annotations, log }) => {
			const parts = [`### ${name}`];
			if (summary) parts.push(summary);
			const errors = annotations
				.filter((note) => note.annotation_level !== "notice")
				.slice(0, 20)
				.map(
					(note) =>
						`- ${note.path}:${note.start_line} ${note.annotation_level}: ${note.message}`,
				);
			if (errors.length) parts.push(`Annotations:\n${errors.join("\n")}`);
			if (log) parts.push(`End of the job log:\n\`\`\`\n${log}\n\`\`\``);
			return parts.join("\n\n");
		})
		.join("\n\n");
}
