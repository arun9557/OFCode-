/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class PageExtractor {
	/**
	 * Fetches webpage HTML and removes non-content elements (scripts, styles, navs, footers).
	 */
	static async extractCleanHtml(url: string, timeoutMs: number = 8000): Promise<string> {
		try {
			const res = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; CleanWebExtractor/1.0)',
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
