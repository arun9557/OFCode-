/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ISearchResult {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
}

export class SearchEngine {
	/**
	 * Performs web search using DuckDuckGo HTML without requiring API keys.
	 */
	static async search(query: string, maxResults: number = 5): Promise<ISearchResult[]> {
		try {
			const encodedQuery = encodeURIComponent(query);
			const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

			const res = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml',
				},
				signal: AbortSignal.timeout(10000)
			});

			if (!res.ok) {
				return [];
			}

			const html = await res.text();
			return this._parseDuckDuckGoHtml(html, maxResults);
		} catch (err) {
			console.warn('Web search request failed:', err);
			return [];
		}
	}

	private static _parseDuckDuckGoHtml(html: string, maxResults: number): ISearchResult[] {
		const results: ISearchResult[] = [];
		// Match result blocks
		const resultRegex = /<a[^>]+class="result__url"[^>]+href="([^"]+)"[^>]*>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
		let match: RegExpExecArray | null;

		while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
			let rawUrl = match[1];
			// Decode DDG redirect URL if present
			const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
			if (uddgMatch) {
				rawUrl = decodeURIComponent(uddgMatch[1]);
			}
			const rawSnippet = match[2].replace(/<[^>]+>/g, '').trim();

			results.push({
				title: rawUrl.split('/').pop() || rawUrl,
				url: rawUrl,
				snippet: rawSnippet
			});
		}

		// Fallback simpler regex if DDG markup changed slightly
		if (results.length === 0) {
			const linkRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
			while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
				results.push({
					title: 'Search Result',
					url: match[1],
					snippet: match[2].replace(/<[^>]+>/g, '').trim()
				});
			}
		}

		return results;
	}
}
