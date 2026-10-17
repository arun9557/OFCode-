/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitHubClient } from './githubClient.js';
import { truncateToTokenBudget } from '../tokenBudget.js';

export interface IGitHubExploreResult {
	readonly success: boolean;
	readonly action: string;
	readonly summary: string;
}

export class GitHubExplorerService {
	private readonly _client: GitHubClient;

	constructor(token?: string) {
		this._client = new GitHubClient(token);
	}

	setToken(token: string | undefined): void {
		this._client.setToken(token);
	}

	async exploreRepoTree(owner: string, repo: string, pathPrefix?: string, maxTokens: number = 1000): Promise<IGitHubExploreResult> {
		try {
			const tree = await this._client.getRepoTree(owner, repo);
			let filtered = tree;
			if (pathPrefix) {
				filtered = tree.filter(t => t.path.startsWith(pathPrefix));
			}

			const filePaths = filtered.slice(0, 50).map(t => `${t.type === 'tree' ? '📁' : '📄'} ${t.path}`).join('\n');
			const summary = `Repository structure for ${owner}/${repo}:\n\n` + truncateToTokenBudget(filePaths, maxTokens);

			return {
				success: true,
				action: 'exploreRepoTree',
				summary
			};
		} catch (err) {
			return {
				success: false,
				action: 'exploreRepoTree',
				summary: `Error exploring repository: ${err}`
			};
		}
	}

	async readRemoteFile(owner: string, repo: string, path: string, maxTokens: number = 1500): Promise<IGitHubExploreResult> {
		try {
			const content = await this._client.getFileContent(owner, repo, path);
			const truncated = truncateToTokenBudget(content, maxTokens);
			return {
				success: true,
				action: 'readRemoteFile',
				summary: `File: ${owner}/${repo}/${path}\n\n\`\`\`\n${truncated}\n\`\`\``
			};
		} catch (err) {
			return {
				success: false,
				action: 'readRemoteFile',
				summary: `Error reading file ${path}: ${err}`
			};
		}
	}

	async searchIssuesAndFixes(query: string, maxTokens: number = 1200): Promise<IGitHubExploreResult> {
		try {
			const issues = await this._client.searchIssues(query, 3);
			if (issues.length === 0) {
				return {
					success: true,
					action: 'searchIssuesAndFixes',
					summary: `No GitHub issues found matching query: "${query}"`
				};
			}

			const parts: string[] = [];
			for (const issue of issues) {
				const bodySnippet = truncateToTokenBudget(issue.body || 'No description provided', 250);
				parts.push(`- **[#${issue.number} ${issue.title}](${issue.html_url})** (${issue.state})\n  ${bodySnippet}`);
			}

			return {
				success: true,
				action: 'searchIssuesAndFixes',
				summary: `GitHub Issues matching "${query}":\n\n` + truncateToTokenBudget(parts.join('\n\n'), maxTokens)
			};
		} catch (err) {
			return {
				success: false,
				action: 'searchIssuesAndFixes',
				summary: `Error searching GitHub issues: ${err}`
			};
		}
	}
}
