/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SearchEngine, ISearchResult } from './searchEngine.js';
import { PageExtractor } from './pageExtractor.js';
import { MarkdownConverter } from './markdownConverter.js';
import { ContentCompressor } from './contentCompressor.js';

export interface IWebExtractionResult {
	readonly url?: string;
	readonly query?: string;
	readonly searchResults?: ISearchResult[];
	readonly extractedMarkdown: string;
}

export class WebExtractorService {
	async extractUrl(url: string, maxTokens: number = 1500): Promise<IWebExtractionResult> {
		const html = await PageExtractor.extractCleanHtml(url);
		const rawMarkdown = MarkdownConverter.htmlToMarkdown(html);
		const compressed = ContentCompressor.compress(rawMarkdown, maxTokens);

		return {
			url,
			extractedMarkdown: compressed
		};
	}

	async searchAndExtract(query: string, maxPages: number = 2, maxTokens: number = 1500): Promise<IWebExtractionResult> {
		const searchResults = await SearchEngine.search(query, 5);

		if (searchResults.length === 0) {
			return {
				query,
				extractedMarkdown: 'No search results found for query: ' + query
			};
		}

		const pagesToExtract = searchResults.slice(0, maxPages);
		const extractedParts: string[] = [];
		const perPageBudget = Math.floor(maxTokens / pagesToExtract.length);

		for (const result of pagesToExtract) {
			try {
				const html = await PageExtractor.extractCleanHtml(result.url);
				const md = MarkdownConverter.htmlToMarkdown(html);
				const compressed = ContentCompressor.compress(md, perPageBudget);
				extractedParts.push(`### Source: [${result.title}](${result.url})\n\n${compressed}`);
			} catch {
				extractedParts.push(`### Source: [${result.title}](${result.url})\n\nSnippet: ${result.snippet}`);
			}
		}

		return {
			query,
			searchResults,
			extractedMarkdown: extractedParts.join('\n\n---\n\n')
		};
	}
}
