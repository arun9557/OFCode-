/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOllamaToolCall } from './ollamaClient.js';

export interface IParsedToolCall {
	readonly name: string;
	readonly parameters: Record<string, unknown>;
	readonly rawId?: string;
}

export class ToolCallParser {
	/**
	 * Extracts tool calls from either Ollama's native tool_calls array,
	 * or falls back to robust regex matching of JSON blocks if a 3B/7B model outputs them inline.
	 */
	static parse(nativeCalls?: IOllamaToolCall[], rawContent?: string): IParsedToolCall[] {
		const results: IParsedToolCall[] = [];

		if (nativeCalls && nativeCalls.length > 0) {
			for (const call of nativeCalls) {
				if (call.function && call.function.name) {
					results.push({
						name: call.function.name,
						parameters: call.function.arguments || {},
					});
				}
			}
			return results;
		}

		if (!rawContent) {
			return results;
		}

		// Fallback 1: Look for ```json ... ``` code blocks containing tool invocation patterns
		const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
		let match: RegExpExecArray | null;

		while ((match = jsonBlockRegex.exec(rawContent)) !== null) {
			try {
				const parsed = JSON.parse(match[1]);
				if (parsed.name && (parsed.parameters || parsed.arguments)) {
					results.push({
						name: parsed.name,
						parameters: parsed.parameters || parsed.arguments || {},
					});
				} else if (parsed.tool && (parsed.input || parsed.parameters)) {
					results.push({
						name: parsed.tool,
						parameters: parsed.input || parsed.parameters || {},
					});
				}
			} catch {
				// Ignore malformed JSON block
			}
		}

		if (results.length > 0) {
			return results;
		}

		// Fallback 2: Look for raw {"name": "...", "parameters": {...}} objects anywhere in text
		const rawObjectRegex = /\{\s*"(?:tool|name)"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments|input)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
		while ((match = rawObjectRegex.exec(rawContent)) !== null) {
			try {
				const name = match[1];
				const params = JSON.parse(match[2]);
				results.push({
					name,
					parameters: params,
				});
			} catch {
				// Ignore malformed JSON snippet
			}
		}

		return results;
	}
}
