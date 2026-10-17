/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IOllamaModelTag {
	readonly name: string;
	readonly model: string;
	readonly modified_at: string;
	readonly size: number;
	readonly digest: string;
	readonly details: {
		readonly parent_model: string;
		readonly format: string;
		readonly family: string;
		readonly families: string[];
		readonly parameter_size: string;
		readonly quantization_level: string;
	};
}

export interface IOllamaTagsResponse {
	readonly models: IOllamaModelTag[];
}

export interface IOllamaChatMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly images?: string[];
	readonly tool_calls?: IOllamaToolCall[];
}

export interface IOllamaToolCall {
	readonly function: {
		readonly name: string;
		readonly arguments: Record<string, unknown>;
	};
}

export interface IOllamaToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: {
			readonly type: 'object';
			readonly properties: Record<string, unknown>;
			readonly required?: string[];
		};
	};
}

export interface IOllamaChatRequestOptions {
	readonly model: string;
	readonly messages: IOllamaChatMessage[];
	readonly stream?: boolean;
	readonly format?: 'json' | Record<string, unknown>;
	readonly tools?: IOllamaToolDefinition[];
	readonly options?: {
		readonly num_ctx?: number;
		readonly temperature?: number;
		readonly top_p?: number;
		readonly num_predict?: number;
		readonly stop?: string[];
	};
}

export interface IOllamaChatChunkResponse {
	readonly model: string;
	readonly created_at: string;
	readonly message?: IOllamaChatMessage;
	readonly done: boolean;
	readonly total_duration?: number;
	readonly prompt_eval_count?: number;
	readonly eval_count?: number;
}

export interface IOllamaEmbeddingResponse {
	readonly model: string;
	readonly embeddings: number[][];
	readonly total_duration?: number;
}

export class OllamaClient {
	private readonly _baseUrl: string;

	constructor(baseUrl: string = 'http://127.0.0.1:11434') {
		this._baseUrl = baseUrl.replace(/\/+$/, '');
	}

	get baseUrl(): string {
		return this._baseUrl;
	}

	async isAlive(): Promise<boolean> {
		try {
			const res = await fetch(`${this._baseUrl}/api/version`, { method: 'GET', signal: AbortSignal.timeout(3000) });
			return res.ok;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<IOllamaModelTag[]> {
		const res = await fetch(`${this._baseUrl}/api/tags`, {
			method: 'GET',
			headers: { 'Accept': 'application/json' },
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) {
			throw new Error(`Ollama list models failed: ${res.status} ${res.statusText}`);
		}
		const data = (await res.json()) as IOllamaTagsResponse;
		return data.models || [];
	}

	async showModel(name: string): Promise<Record<string, unknown>> {
		const res = await fetch(`${this._baseUrl}/api/show`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: name }),
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) {
			throw new Error(`Ollama show model failed: ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as Record<string, unknown>;
	}

	async chat(request: IOllamaChatRequestOptions, signal?: AbortSignal): Promise<IOllamaChatChunkResponse> {
		const res = await fetch(`${this._baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...request, stream: false }),
			signal: signal || AbortSignal.timeout(60000)
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Ollama chat error ${res.status}: ${text}`);
		}
		return (await res.json()) as IOllamaChatChunkResponse;
	}

	async *chatStream(request: IOllamaChatRequestOptions, signal?: AbortSignal): AsyncGenerator<IOllamaChatChunkResponse, void, unknown> {
		const res = await fetch(`${this._baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...request, stream: true }),
			signal: signal || AbortSignal.timeout(120000)
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Ollama stream error ${res.status}: ${text}`);
		}

		if (!res.body) {
			throw new Error('Response body is empty');
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.length > 0) {
						yield JSON.parse(trimmed) as IOllamaChatChunkResponse;
					}
				}
			}

			if (buffer.trim().length > 0) {
				yield JSON.parse(buffer.trim()) as IOllamaChatChunkResponse;
			}
		} finally {
			reader.releaseLock();
		}
	}

	async generateEmbeddings(model: string, input: string | string[], signal?: AbortSignal): Promise<number[][]> {
		const res = await fetch(`${this._baseUrl}/api/embed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, input }),
			signal: signal || AbortSignal.timeout(30000)
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Ollama embed error ${res.status}: ${text}`);
		}

		const data = (await res.json()) as IOllamaEmbeddingResponse;
		return data.embeddings;
	}
}
