/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IGitHubTreeItem {
	readonly path: string;
	readonly mode: string;
	readonly type: 'blob' | 'tree';
	readonly sha: string;
	readonly size?: number;
}

export interface IGitHubIssue {
	readonly title: string;
	readonly number: number;
	readonly html_url: string;
	readonly state: string;
	readonly body: string;
	readonly comments: number;
}

export class GitHubClient {
	private readonly _baseUrl = 'https://api.github.com';
	private _token?: string;

	constructor(token?: string) {
		this._token = token;
	}

	setToken(token: string | undefined): void {
		this._token = token;
	}

	private _getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Accept': 'application/vnd.github.v3+json',
			'User-Agent': 'VSCode-OfflineAgent/1.0',
		};
		if (this._token) {
			headers['Authorization'] = `token ${this._token}`;
		}
		return headers;
	}

	async getRepoTree(owner: string, repo: string, branch: string = 'main'): Promise<IGitHubTreeItem[]> {
		const url = `${this._baseUrl}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
		const res = await fetch(url, { headers: this._getHeaders(), signal: AbortSignal.timeout(10000) });
		if (!res.ok) {
			throw new Error(`GitHub getRepoTree failed: ${res.status} ${res.statusText}`);
		}
		const data = await res.json() as { tree?: IGitHubTreeItem[] };
		return data.tree || [];
	}

	async getFileContent(owner: string, repo: string, path: string): Promise<string> {
		const url = `${this._baseUrl}/repos/${owner}/${repo}/contents/${path}`;
		const res = await fetch(url, { headers: this._getHeaders(), signal: AbortSignal.timeout(10000) });
		if (!res.ok) {
			throw new Error(`GitHub getFileContent failed: ${res.status} ${res.statusText}`);
		}
		const data = await res.json() as { content?: string; encoding?: string };
		if (data.content && data.encoding === 'base64') {
			return atob(data.content.replace(/\s/g, ''));
		}
		return JSON.stringify(data);
	}

	async searchIssues(query: string, maxResults: number = 5): Promise<IGitHubIssue[]> {
		const encoded = encodeURIComponent(query);
		const url = `${this._baseUrl}/search/issues?q=${encoded}&per_page=${maxResults}`;
		const res = await fetch(url, { headers: this._getHeaders(), signal: AbortSignal.timeout(10000) });
		if (!res.ok) {
			throw new Error(`GitHub searchIssues failed: ${res.status}`);
		}
		const data = await res.json() as { items?: IGitHubIssue[] };
		return data.items || [];
	}

	async searchCode(query: string, maxResults: number = 5): Promise<Array<{ path: string; repository: { full_name: string }; html_url: string }>> {
		const encoded = encodeURIComponent(query);
		const url = `${this._baseUrl}/search/code?q=${encoded}&per_page=${maxResults}`;
		const res = await fetch(url, { headers: this._getHeaders(), signal: AbortSignal.timeout(10000) });
		if (!res.ok) {
			throw new Error(`GitHub searchCode failed: ${res.status}`);
		}
		const data = await res.json() as { items?: Array<{ path: string; repository: { full_name: string }; html_url: string }> };
		return data.items || [];
	}
}
