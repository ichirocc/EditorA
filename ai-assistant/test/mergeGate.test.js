import { describe, expect, it } from "vitest";
import { evaluateMergeReadiness } from "../core/mergeGate.js";

const openPr = {
	state: "open",
	merged: false,
	draft: false,
	mergeable: true,
	mergeable_state: "clean",
};

const passingRun = {
	name: "build",
	status: "completed",
	conclusion: "success",
};

describe("AI assistant merge gate", () => {
	it("allows a clean pull request with passing checks", () => {
		const readiness = evaluateMergeReadiness({
			pr: openPr,
			checkRuns: [
				passingRun,
				{ ...passingRun, name: "lint", conclusion: "skipped" },
			],
			combinedStatus: {
				statuses: [{ context: "ci/external", state: "success" }],
			},
		});
		expect(readiness).toMatchObject({
			ready: true,
			pending: false,
			blockers: [],
			warnings: [],
		});
		expect(readiness.checks).toHaveLength(3);
	});

	it("blocks while checks are still running", () => {
		const readiness = evaluateMergeReadiness({
			pr: openPr,
			checkRuns: [
				passingRun,
				{ name: "tests", status: "in_progress", conclusion: null },
			],
		});
		expect(readiness.ready).toBe(false);
		expect(readiness.pending).toBe(true);
		expect(readiness.blockers).toEqual([
			{ code: "ci running", names: ["tests"] },
		]);
	});

	it("blocks failed checks and keeps their summary", () => {
		const readiness = evaluateMergeReadiness({
			pr: openPr,
			checkRuns: [
				{
					name: "tests",
					status: "completed",
					conclusion: "failure",
					output: { title: "2 failed", summary: "expected 1 to be 2" },
				},
				{ name: "deploy", status: "completed", conclusion: "cancelled" },
			],
			combinedStatus: {
				statuses: [{ context: "legacy", state: "error", description: "boom" }],
			},
		});
		expect(readiness.ready).toBe(false);
		expect(readiness.blockers).toEqual([
			{ code: "ci failed", names: ["tests", "deploy", "legacy"] },
		]);
		expect(readiness.checks[0].summary).toBe("2 failed\nexpected 1 to be 2");
		expect(readiness.checks[2].summary).toBe("boom");
	});

	it("blocks conflicts, protection and out-of-date branches", () => {
		const blockerFor = (pr) =>
			evaluateMergeReadiness({
				pr: { ...openPr, ...pr },
				checkRuns: [passingRun],
			}).blockers;

		expect(blockerFor({ mergeable: false, mergeable_state: "dirty" })).toEqual([
			{ code: "conflict" },
		]);
		expect(blockerFor({ mergeable_state: "blocked" })).toEqual([
			{ code: "protected" },
		]);
		expect(blockerFor({ mergeable_state: "behind" })).toEqual([
			{ code: "behind" },
		]);
		expect(blockerFor({ draft: true, mergeable_state: "draft" })).toEqual([
			{ code: "draft" },
		]);
	});

	it("waits while GitHub computes mergeability", () => {
		const readiness = evaluateMergeReadiness({
			pr: { ...openPr, mergeable: null, mergeable_state: "unknown" },
			checkRuns: [passingRun],
		});
		expect(readiness.ready).toBe(false);
		expect(readiness.pending).toBe(true);
		expect(readiness.blockers).toEqual([{ code: "computing" }]);
	});

	it("refuses merged and closed pull requests", () => {
		expect(
			evaluateMergeReadiness({
				pr: { ...openPr, state: "closed", merged: true },
				checkRuns: [passingRun],
			}).blockers,
		).toContainEqual({ code: "merged" });
		expect(
			evaluateMergeReadiness({
				pr: { ...openPr, state: "closed" },
				checkRuns: [passingRun],
			}).blockers,
		).toContainEqual({ code: "closed" });
	});

	it("allows a merge without CI but warns about it", () => {
		const readiness = evaluateMergeReadiness({
			pr: openPr,
			checkRuns: [],
			combinedStatus: { state: "pending", statuses: [] },
		});
		expect(readiness.ready).toBe(true);
		expect(readiness.warnings).toEqual(["no checks"]);
	});
});
