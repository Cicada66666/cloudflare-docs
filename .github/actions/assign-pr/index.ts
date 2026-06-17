// NOTE: This is the source file!
// ~> Run `npm run build` to produce `index.js`

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";

type Octokit = ReturnType<typeof github.getOctokit>;

type Options = {
	repo: string;
	owner: string;
	pull_number: number;
	per_page?: number;
	page?: number;
};

type CodeOwnerRule = {
	pattern: string;
	owners: string[];
};

function loadCodeOwners(cwd: string): CodeOwnerRule[] {
	const codeownersPath = path.join(cwd, "CODEOWNERS");
	if (!fs.existsSync(codeownersPath)) {
		return [];
	}

	const content = fs.readFileSync(codeownersPath, "utf8");
	const rules: CodeOwnerRule[] = [];

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const parts = trimmed.split(/\s+/);
		if (parts.length >= 2) {
			const pattern = parts[0];
			const owners = parts.slice(1);
			rules.push({ pattern, owners });
		}
	}

	return rules;
}

function matchFile(
	filePath: string,
	rules: CodeOwnerRule[],
): { owners: string[] } | null {
	let matchedOwners: string[] = [];

	for (const rule of rules) {
		const pattern = rule.pattern;

		let matches = false;
		if (pattern.startsWith("/")) {
			const patternPath = pattern.slice(1);
			if (pattern.endsWith("/")) {
				matches = filePath.startsWith(patternPath);
			} else if (pattern.includes("*")) {
				matches = globMatch(patternPath, filePath);
			} else {
				matches = filePath === patternPath || filePath.startsWith(patternPath + "/");
			}
		} else if (pattern.includes("/")) {
			if (pattern.endsWith("/")) {
				matches = filePath.includes(pattern) || filePath.startsWith(pattern);
			} else {
				matches = filePath === pattern || filePath.endsWith("/" + pattern);
			}
		} else {
			const fileName = filePath.split("/").pop() || "";
			if (pattern.includes("*")) {
				matches = globMatch(pattern, fileName);
			} else {
				matches = fileName === pattern;
			}
		}

		if (matches) {
			matchedOwners = rule.owners;
		}
	}

	return matchedOwners.length > 0 ? { owners: matchedOwners } : null;
}

function globMatch(pattern: string, str: string): boolean {
	const regexPattern = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, ".");
	const regex = new RegExp(`^${regexPattern}$`);
	return regex.test(str);
}

// @see https://octokit.github.io/rest.js/v18#pulls-list-files
async function list(
	client: Octokit,
	options: Options,
	products?: Set<string>,
): Promise<Set<string>> {
	products = products || new Set();
	options.page = options.page || 1;

	let limit = (options.per_page = options.per_page || 100);
	let res = await client.rest.pulls.listFiles(options);

	// retrieve the filenames
	let i = 0,
		len = res.data.length;
	for (let file, tmp: string | void; i < len; i++) {
		file = res.data[i];
		products.add(file.filename);
	}

	// if less than limit, stop
	if (len < limit) return products;

	options.page++; //~> next page
	return list(client, options, products);
}

(async function () {
	try {
		let cwd = process.cwd();
		let codeowners = loadCodeOwners(cwd);
		const token = core.getInput("GITHUB_TOKEN", { required: true });

		const payload = github.context.payload;

		const { repository, pull_request } = payload;
		if (!pull_request) throw new Error('Missing "pull_request" object!');

		// establish variables
		const assignees = new Set<string>();
		const prnumber = pull_request.number;
		const author = pull_request.user.login;
		const client = github.getOctokit(token);

		// Determine assignees based on files in PR diff.

		// https://octokit.github.io/rest.js/v18#pulls-list-files

		const files = await list(client, {
			repo: repository.name,
			owner: repository.owner.login,
			pull_number: prnumber,
		});

		for (const file of files) {
			const match = matchFile(file, codeowners);
			if (match && match.owners) {
				for (const owner of match.owners) {
					if (!owner.includes("/")) {
						assignees.add(owner.replace(/^@/, ""));
					}
				}
			}
			// don't self-assign
			assignees.delete(author);

			try {
				if (assignees.size > 0) {
					await client.rest.issues.addAssignees({
						repo: repository.name,
						owner: repository.owner.login,
						issue_number: prnumber,
						assignees: [...assignees],
					});
				}
			} catch (error) {
				core.setFailed(error.message);
			}
			console.log("DONE~!");
		}
	} catch (error) {
		core.setFailed(error.message);
	}
})();
