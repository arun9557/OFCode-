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
	 * or falls back to robust regex matching of tool_call tags, markdown JSON blocks,
	 * or function call patterns if a 3B/7B/14B model outputs them inline.
	 */
	static parse(nativeCalls?: IOllamaToolCall[], rawContent?: string): IParsedToolCall[] {
		const results: IParsedToolCall[] = [];
		const seen = new Set<string>();

		const addCall = (name: string, rawParams: unknown): void => {
			if (!name) {
				return;
			}
			let parameters: Record<string, unknown> = {};
			if (typeof rawParams === 'string') {
				try {
					parameters = JSON.parse(rawParams);
				} catch {
					parameters = {};
				}
			} else if (typeof rawParams === 'object' && rawParams !== null) {
				parameters = rawParams as Record<string, unknown>;
			}

			const key = `${name}:${JSON.stringify(parameters)}`;
			if (!seen.has(key)) {
				seen.add(key);
				results.push({ name, parameters });
			}
		};

		if (nativeCalls && nativeCalls.length > 0) {
			for (const call of nativeCalls) {
				if (call.function && call.function.name) {
					addCall(call.function.name, call.function.arguments);
				}
			}
			if (results.length > 0) {
				return results;
			}
		}

		if (!rawContent) {
			return results;
		}

		// Pattern 1: <tool_call> ... </tool_call> tags (Qwen 2.5/3, DeepSeek)
		const toolCallTagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
		let tagMatch: RegExpExecArray | null;
		while ((tagMatch = toolCallTagRegex.exec(rawContent)) !== null) {
			try {
				const trimmed = tagMatch[1].trim();
				const parsed = JSON.parse(trimmed);
				const name = parsed.name || parsed.tool || parsed.function?.name;
				const params = parsed.arguments || parsed.parameters || parsed.input || parsed.args || parsed.function?.arguments || {};
				if (name) {
					addCall(name, params);
				}
			} catch {
				// Try nested matching if inner content contains json
			}
		}

		// Pattern 2: <function=name> ... </function> (Llama-3 / Hermes)
		const fnTagRegex = /<function=([^>]+)>([\s\S]*?)<\/function>/gi;
		while ((tagMatch = fnTagRegex.exec(rawContent)) !== null) {
			const name = tagMatch[1].trim();
			try {
				const params = JSON.parse(tagMatch[2].trim());
				addCall(name, params);
			} catch {
				addCall(name, {});
			}
		}

		// Pattern 3: [TOOL_CALL: name(args)]
		const bracketRegex = /\[TOOL_CALL:\s*([a-zA-Z0-9_-]+)\s*\(([\s\S]*?)\)\]/gi;
		while ((tagMatch = bracketRegex.exec(rawContent)) !== null) {
			const name = tagMatch[1].trim();
			try {
				const params = JSON.parse(tagMatch[2].trim());
				addCall(name, params);
			} catch {
				addCall(name, {});
			}
		}

		// Pattern 4: ```json ... ``` or ``` ... ``` code blocks containing tool invocation patterns
		const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
		let match: RegExpExecArray | null;
		while ((match = jsonBlockRegex.exec(rawContent)) !== null) {
			try {
				const parsed = JSON.parse(match[1]);
				const name = parsed.name || parsed.tool || parsed.function?.name;
				const params = parsed.parameters || parsed.arguments || parsed.input || parsed.args || parsed.function?.arguments;
				if (name && params !== undefined) {
					addCall(name, params);
				}
			} catch {
				// Ignore malformed JSON block
			}
		}

		// Pattern 5: Look for raw {"name": "...", "parameters": {...}} or {"tool": "...", "arguments": {...}} objects anywhere in text
		const rawObjectRegex = /\{\s*"(?:tool|name)"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments|input|args)"\s*:\s*(\{[\s\S]*?\}|"[^"]*")\s*\}/g;
		while ((match = rawObjectRegex.exec(rawContent)) !== null) {
			try {
				const name = match[1];
				let params: unknown;
				try {
					params = JSON.parse(match[2]);
				} catch {
					params = match[2];
				}
				addCall(name, params);
			} catch {
				// Ignore malformed JSON snippet
			}
		}

		return results;
	}
}
