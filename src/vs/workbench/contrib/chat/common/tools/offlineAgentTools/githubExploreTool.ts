/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';
import { createToolSimpleTextResult } from '../builtinTools/toolHelpers.js';
import { OfflineAgentToolId } from './offlineAgentToolIds.js';
import { GitHubExplorerService } from '../../offlineAgent/githubExplorer/githubExplorerService.js';

export const GitHubExploreToolData: IToolData = {
	id: OfflineAgentToolId.GitHubExplore,
	toolReferenceName: 'github_explore',
	displayName: localize('tool.githubExplore.displayName', 'GitHub Deep Explorer'),
	userDescription: localize('tool.githubExplore.userDescription', 'Explores remote GitHub repositories, reads files, and searches for bug fixes in Issues and PRs.'),
	modelDescription: 'Explore GitHub repositories, read remote files, or search issues for bug solutions. Input: { action: "tree" | "readFile" | "searchIssues", owner?: string, repo?: string, path?: string, query?: string }',
	icon: ThemeIcon.fromId(Codicon.github.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ['tree', 'readFile', 'searchIssues'],
				description: 'The GitHub action to execute.'
			},
			owner: {
				type: 'string',
				description: 'Repository owner (e.g. "microsoft").'
			},
			repo: {
				type: 'string',
				description: 'Repository name (e.g. "vscode").'
			},
			path: {
				type: 'string',
				description: 'File path inside repository (for "readFile" or "tree" filter).'
			},
			query: {
				type: 'string',
				description: 'Search query for issues/fixes (for "searchIssues").'
			}
		},
		required: ['action']
	}
};

interface IGitHubExploreInput {
	action: 'tree' | 'readFile' | 'searchIssues';
	owner?: string;
	repo?: string;
	path?: string;
	query?: string;
}

export class GitHubExploreTool implements IToolImpl {
	private readonly _githubService: GitHubExplorerService;

	constructor() {
		this._githubService = new GitHubExplorerService();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as IGitHubExploreInput;
		return {
			invocationMessage: localize('tool.githubExplore.invoking', 'Querying GitHub ({0})...', input.action)
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as IGitHubExploreInput;

		try {
			if (input.action === 'tree') {
				if (!input.owner || !input.repo) {
					return createToolSimpleTextResult('Error: "owner" and "repo" are required for the "tree" action.');
				}
				const res = await this._githubService.exploreRepoTree(input.owner, input.repo, input.path);
				return createToolSimpleTextResult(res.summary);
			}

			if (input.action === 'readFile') {
				if (!input.owner || !input.repo || !input.path) {
					return createToolSimpleTextResult('Error: "owner", "repo", and "path" are required for the "readFile" action.');
				}
				const res = await this._githubService.readRemoteFile(input.owner, input.repo, input.path);
				return createToolSimpleTextResult(res.summary);
			}

			if (input.action === 'searchIssues') {
				if (!input.query) {
					return createToolSimpleTextResult('Error: "query" is required for the "searchIssues" action.');
				}
				const res = await this._githubService.searchIssuesAndFixes(input.query);
				return createToolSimpleTextResult(res.summary);
			}

			return createToolSimpleTextResult(`Unknown action: ${input.action}`);
		} catch (err) {
			return createToolSimpleTextResult(`GitHub Explore error: ${err}`);
		}
	}
}
