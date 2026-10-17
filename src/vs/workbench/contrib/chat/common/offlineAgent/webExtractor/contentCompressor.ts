/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { estimateTokenCount, truncateToTokenBudget } from '../tokenBudget.js';

export class ContentCompressor {
	/**
	 * Compresses Markdown content to fit inside a target token budget.
	 * Prioritizes code blocks, headings, and early paragraphs.
	 */
	static compress(markdown: string, maxTokens: number = 1500): string {
		const totalTokens = estimateTokenCount(markdown);
		if (totalTokens <= maxTokens) {
			return markdown;
		}

		const sections = markdown.split('\n\n');
		const prioritized: string[] = [];
		let accumulatedTokens = 0;

		// Pass 1: Keep headings and code blocks
		for (const section of sections) {
			const isHeading = section.startsWith('#');
			const isCode = section.includes('```');

			if (isHeading || isCode) {
				const sectionTokens = estimateTokenCount(section);
				if (accumulatedTokens + sectionTokens < maxTokens * 0.7) {
					prioritized.push(section);
					accumulatedTokens += sectionTokens;
				}
			}
		}

		// Pass 2: Fill remaining space with paragraphs
		for (const section of sections) {
			if (!prioritized.includes(section)) {
				const sectionTokens = estimateTokenCount(section);
				if (accumulatedTokens + sectionTokens < maxTokens) {
					prioritized.push(section);
					accumulatedTokens += sectionTokens;
				} else {
					break;
				}
			}
		}

		const combined = prioritized.join('\n\n');
		return truncateToTokenBudget(combined, maxTokens);
	}
}
