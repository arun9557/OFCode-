/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asText, IRequestService } from '../../../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';

export class PageExtractor {
	/**
	 * Fetches webpage HTML using IRequestService (Node network stack without browser CORS restrictions)
	 * or falls back to fetch if requestService is not provided.
	 */
	static async extractCleanHtml(url: string, requestService?: IRequestService, timeoutMs: number = 10000): Promise<string> {
		if (requestService) {
			try {
				const context = await requestService.request({
					type: 'GET',
					url,
					headers: {
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					},
					timeout: timeoutMs,
					callSite: 'ofcode.pageExtractor'
				}, CancellationToken.None);

				const text = await asText(context);
				if (text && text.trim().length > 0) {
					return this.sanitizeHtml(text);
				}
			} catch (reqErr) {
				console.warn('[PageExtractor] IRequestService fetch failed, falling back to global fetch:', reqErr);
			}
		}

		try {
			const res = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml',
				},
				signal: AbortSignal.timeout(timeoutMs)
			});

			if (!res.ok) {
				return `Error: HTTP ${res.status} when fetching ${url}`;
			}

			const html = await res.text();
			return this.sanitizeHtml(html);
		} catch (err) {
			return `Failed to fetch page: ${err}`;
		}
	}

	static sanitizeHtml(html: string): string {
		let clean = html;

		// 1. Strip script, style, noscript, svg, iframe, nav, header, footer elements
		clean = clean.replace(/<script[\s\S]*?<\/script>/gi, '');
		clean = clean.replace(/<style[\s\S]*?<\/style>/gi, '');
		clean = clean.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
		clean = clean.replace(/<svg[\s\S]*?<\/svg>/gi, '');
		clean = clean.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
		clean = clean.replace(/<nav[\s\S]*?<\/nav>/gi, '');
		clean = clean.replace(/<header[\s\S]*?<\/header>/gi, '');
		clean = clean.replace(/<footer[\s\S]*?<\/footer>/gi, '');

		// 2. Keep main/article/body if identifiable
		const articleMatch = clean.match(/<article[\s\S]*?<\/article>/i);
		if (articleMatch) {
			clean = articleMatch[0];
		} else {
			const mainMatch = clean.match(/<main[\s\S]*?<\/main>/i);
			if (mainMatch) {
				clean = mainMatch[0];
			}
		}

		return clean;
	}
}
