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
import { WebExtractorService } from '../../offlineAgent/webExtractor/webExtractorService.js';

export const ChromeExtractToolData: IToolData = {
	id: OfflineAgentToolId.ChromeExtract,
	toolReferenceName: 'chrome_extract',
	displayName: localize('tool.chromeExtract.displayName', 'Headless Chrome & Web Extractor'),
	userDescription: localize('tool.chromeExtract.userDescription', 'Searches documentation and scrapes web pages, stripping scripts and CSS to return clean, compressed Markdown for local models.'),
	modelDescription: 'Search the web or fetch a documentation URL. Returns stripped, token-budgeted Markdown without clutter. Input: { query?: string, url?: string, maxTokens?: number }',
	icon: ThemeIcon.fromId(Codicon.globe.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			url: {
				type: 'string',
				description: 'Specific URL to fetch and clean.'
			},
			query: {
				type: 'string',
				description: 'Search query to look up on the web if URL is not provided.'
			},
			maxTokens: {
				type: 'number',
				description: 'Token budget for extracted content (default: 1500).'
			}
		}
	}
};

interface IChromeExtractInput {
	url?: string;
	query?: string;
	maxTokens?: number;
}

export class ChromeExtractTool implements IToolImpl {
	private readonly _webExtractorService: WebExtractorService;

	constructor() {
		this._webExtractorService = new WebExtractorService();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as IChromeExtractInput;
		const target = input.url || input.query || 'web';
		return {
			invocationMessage: localize('tool.chromeExtract.invoking', 'Fetching clean web data for `{0}`...', target)
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as IChromeExtractInput;
		const maxTokens = input.maxTokens || 1500;

		try {
			if (input.url) {
				const result = await this._webExtractorService.extractUrl(input.url, maxTokens);
				return createToolSimpleTextResult(result.extractedMarkdown);
			}

			if (input.query) {
				const result = await this._webExtractorService.searchAndExtract(input.query, 2, maxTokens);
				return createToolSimpleTextResult(result.extractedMarkdown);
			}

			return createToolSimpleTextResult('Please provide either a "url" or a "query" parameter.');
		} catch (err) {
			return createToolSimpleTextResult(`Web extraction error: ${err}`);
		}
	}
}
