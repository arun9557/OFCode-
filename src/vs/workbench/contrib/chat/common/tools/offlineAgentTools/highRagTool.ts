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
import { HighRagService } from '../../offlineAgent/highRag/highRagService.js';
import { EmbeddingClient } from '../../offlineAgent/highRag/embeddingClient.js';
import { OllamaClient } from '../../offlineAgent/ollamaClient.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';

export const HighRagToolData: IToolData = {
	id: OfflineAgentToolId.HighRag,
	toolReferenceName: 'high_rag',
	displayName: localize('tool.highRag.displayName', 'High-RAG Context Retriever'),
	userDescription: localize('tool.highRag.userDescription', 'Retrieves precise code definitions and dependency call graphs using AST parsing and local embeddings.'),
	modelDescription: 'Retrieve dense code context by analyzing AST functions, classes, and their call dependencies. Input: { query: string, maxTokens?: number }',
	icon: ThemeIcon.fromId(Codicon.symbolClass.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'The search query or symbol name to look up in the codebase.'
			},
			maxTokens: {
				type: 'number',
				description: 'Maximum tokens of context to retrieve (default: 2000).'
			}
		},
		required: ['query']
	}
};

interface IHighRagInput {
	query: string;
	maxTokens?: number;
}

export class HighRagTool implements IToolImpl {
	private readonly _highRagService: HighRagService;

	constructor(
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService
	) {
		const ollamaClient = new OllamaClient();
		const embeddingClient = new EmbeddingClient(ollamaClient);
		this._highRagService = new HighRagService(embeddingClient);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as IHighRagInput;
		return {
			invocationMessage: localize('tool.highRag.searching', 'Searching codebase AST for `{0}`...', input.query)
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as IHighRagInput;
		const maxTokens = input.maxTokens || 2000;

		try {
			const result = await this._highRagService.search(input.query, maxTokens);
			if (result.chunks.length === 0) {
				return createToolSimpleTextResult(`No AST definitions matched the query "${input.query}".`);
			}

			return createToolSimpleTextResult(result.formattedContext);
		} catch (err) {
			return createToolSimpleTextResult(`High-RAG error: ${err}`);
		}
	}
}
