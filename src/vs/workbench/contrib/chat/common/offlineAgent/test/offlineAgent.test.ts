/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ASTParser } from '../highRag/astParser.js';
import { ASTChunker } from '../highRag/astChunker.js';
import { DependencyGraph } from '../highRag/dependencyGraph.js';
import { ToolCallParser } from '../toolCallParser.js';
import { MicroPromptEngine } from '../microPromptEngine.js';
import { estimateTokenCount, truncateToTokenBudget } from '../tokenBudget.js';
import { MarkdownConverter } from '../webExtractor/markdownConverter.js';
import { ContentCompressor } from '../webExtractor/contentCompressor.js';

suite('Offline Agentic Engine Core', () => {

	test('ASTParser extracts functions and classes with dependencies', () => {
		const sampleCode = `
import { TaxConfig } from './config.js';

export function getTaxRate(country: string): number {
	return 0.18;
}

export class OrderProcessor {
	calculateTotal(amount: number, config: TaxConfig): number {
		const rate = getTaxRate('IN');
		return amount + amount * rate;
	}
}
`;
		const nodes = ASTParser.parse(sampleCode, 'sample.ts');
		assert.strictEqual(nodes.length >= 2, true);

		const funcNode = nodes.find(n => n.name === 'getTaxRate');
		assert.ok(funcNode);
		assert.strictEqual(funcNode.kind, 'function');

		const classNode = nodes.find(n => n.name === 'OrderProcessor');
		assert.ok(classNode);
		assert.strictEqual(classNode.kind, 'class');
		assert.ok(classNode.dependencies.includes('TaxConfig'));
	});

	test('DependencyGraph resolves and bundles dependent definitions within token budget', () => {
		const sampleCode = `
export function helperA(): void {}
export function mainFeature(): void {
	helperA();
}
`;
		const nodes = ASTParser.parse(sampleCode, 'test.ts');
		const chunks = ASTChunker.createChunks('test.ts', nodes);

		const graph = new DependencyGraph();
		graph.rebuild(chunks);

		const mainChunk = chunks.find(c => c.symbol === 'mainFeature');
		assert.ok(mainChunk);

		const resolved = graph.resolveDependencies([mainChunk], 500);
		assert.strictEqual(resolved.length, 2);
	});

	test('ToolCallParser extracts native and inline JSON tool calls', () => {
		// Native Ollama tool call
		const nativeCalls = [{
			function: {
				name: 'vscode_highRag',
				arguments: { query: 'OrderProcessor' }
			}
		}];
		const parsedNative = ToolCallParser.parse(nativeCalls);
		assert.strictEqual(parsedNative.length, 1);
		assert.strictEqual(parsedNative[0].name, 'vscode_highRag');
		assert.strictEqual(parsedNative[0].parameters.query, 'OrderProcessor');

		// Fallback inline markdown code block
		const rawMarkdown = `
I will search for the definition first:
\`\`\`json
{
  "name": "vscode_highRag",
  "parameters": { "query": "TaxConfig" }
}
\`\`\`
`;
		const parsedFallback = ToolCallParser.parse(undefined, rawMarkdown);
		assert.strictEqual(parsedFallback.length, 1);
		assert.strictEqual(parsedFallback[0].name, 'vscode_highRag');
		assert.strictEqual(parsedFallback[0].parameters.query, 'TaxConfig');
	});

	test('MicroPromptEngine creates micro-prompts under token limits', () => {
		const prompt = MicroPromptEngine.createPlannerPrompt('Fix bug in auth service');
		const tokens = estimateTokenCount(prompt.systemPrompt + prompt.userPrompt);
		assert.strictEqual(tokens < 200, true);
	});

	test('MarkdownConverter and ContentCompressor compress web content', () => {
		const html = '<h1>Documentation</h1><p>Welcome to the docs.</p><pre><code>const a = 1;</code></pre>';
		const md = MarkdownConverter.htmlToMarkdown(html);
		assert.ok(md.includes('# Documentation'));
		assert.ok(md.includes('const a = 1;'));

		const compressed = ContentCompressor.compress(md, 50);
		assert.ok(compressed.length > 0);
	});

	test('TokenBudget estimates and truncates safely', () => {
		const text = 'Hello world from local Ollama offline agent!';
		const tokens = estimateTokenCount(text);
		assert.ok(tokens > 0);

		const truncated = truncateToTokenBudget(text, 5);
		assert.ok(truncated.includes('truncated to fit'));
	});
});
