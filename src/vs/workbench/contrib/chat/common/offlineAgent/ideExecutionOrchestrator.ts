/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath, dirname } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatProgress } from '../chatService/chatService.js';
import { WebExtractorService } from './webExtractor/webExtractorService.js';
import { HighRagService } from './highRag/highRagService.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface IFileBlock {
	readonly path: string;
	readonly content: string;
}

export interface ICmdBlock {
	readonly command: string;
}

export interface IDiagnosticError {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly message: string;
	readonly severity: string;
}

export interface IExecutionResult {
	readonly filesWritten: string[];
	readonly commandsRun: string[];
	readonly diagnosticErrors: IDiagnosticError[];
	readonly selfHealingAttempts: number;
}

// ─── Orchestrator ───────────────────────────────────────────────────

/**
 * The IDE-Ollama Symbiotic Execution Engine.
 *
 * Manages three core loops on behalf of the agentic agent:
 * 1. **Pre-execution context enrichment** — URL scraping, workspace snapshots, High-RAG.
 * 2. **Post-response auto-application** — file writes, terminal commands.
 * 3. **Self-healing diagnostics loop** — IMarkerService error checking with auto-retry.
 */
export class IDEExecutionOrchestrator extends Disposable {

	private static readonly MAX_SELF_HEAL_RETRIES = 3;
	private static readonly DIAGNOSTICS_WAIT_MS = 800;
	private static readonly FILE_BLOCK_REGEX = /\/\/\s*filepath:\s*(\S+)\s*\n([\s\S]*?)(?=\/\/\s*filepath:|\s*$)/gi;
	private static readonly CMD_REGEX = /<ofcode_cmd>([\s\S]*?)<\/ofcode_cmd>/gi;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly _editorService: IEditorService,
		@IMarkerService private readonly _markerService: IMarkerService,
	) {
		super();
	}

	// ─────────────────────────────────────────────────────────────────
	// Phase 1: Pre-Execution Context Engine
	// ─────────────────────────────────────────────────────────────────

	/**
	 * Enriches the user's raw prompt with auto-scraped URL content,
	 * workspace file tree snapshot, and High-RAG symbol context.
	 */
	async enrichPrompt(
		rawPrompt: string,
		webExtractor: WebExtractorService,
		highRagService: HighRagService,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken
	): Promise<string> {
		let enrichedPrompt = rawPrompt;

		// 1a. Auto-URL extraction (pre-fetch all URLs in the prompt)
		const urlMatches = rawPrompt.match(/https?:\/\/[^\s<>'")\]]+/gi);
		if (urlMatches && urlMatches.length > 0) {
			for (const url of urlMatches) {
				if (token.isCancellationRequested) { break; }
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> 🌐 **IDE Pre-Fetched Web Content** from \`${url}\`...\n\n`)
				}]);
				try {
					const extracted = await webExtractor.extractUrl(url, 3500);
					if (extracted.extractedMarkdown?.trim()) {
						enrichedPrompt = `[IDE Pre-Fetched Web Content from ${url}]:\n${extracted.extractedMarkdown}\n\n[System]: The OFCode IDE Host has pre-fetched this URL. Use the extracted content directly.\n\n---\n\n${enrichedPrompt}`;
						progress([{
							kind: 'markdownContent',
							content: new MarkdownString(`> ✅ IDE extracted ${extracted.extractedMarkdown.length} chars from \`${url}\`\n\n`)
						}]);
					}
				} catch (err) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`> ⚠️ IDE URL pre-fetch failed for \`${url}\`: ${err instanceof Error ? err.message : String(err)}\n\n`)
					}]);
				}
			}
		}

		// 1b. Auto-workspace file tree snapshot
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			try {
				const rootUri = folders[0].uri;
				const treeLines: string[] = ['[IDE Workspace Snapshot]:'];
				await this._buildFileTree(rootUri, treeLines, 0, 3);
				if (treeLines.length > 1) {
					enrichedPrompt = `${treeLines.join('\n')}\n\n---\n\n${enrichedPrompt}`;
				}
			} catch {
				// Silently proceed if tree scan fails
			}
		}

		// 1c. Auto-High-RAG context
		try {
			const ragResult = await highRagService.search(rawPrompt, 1500);
			if (ragResult.formattedContext) {
				enrichedPrompt = `[IDE High-RAG Context (${ragResult.chunks.length} symbols)]:\n${ragResult.formattedContext}\n\n---\n\n${enrichedPrompt}`;
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> 🧠 **IDE High-RAG:** Injected ${ragResult.chunks.length} AST symbol definitions\n\n`)
				}]);
			}
		} catch {
			// Proceed gracefully
		}

		return enrichedPrompt;
	}

	// ─────────────────────────────────────────────────────────────────
	// Phase 2: Auto-Apply Code & Commands
	// ─────────────────────────────────────────────────────────────────

	/**
	 * Parses the model's response for `// filepath:` blocks, XML `<ofcode_file>` blocks,
	 * and `<ofcode_cmd>` blocks, then auto-applies them.
	 */
	async applyResponse(
		responseText: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken
	): Promise<IExecutionResult> {
		const result: IExecutionResult = {
			filesWritten: [],
			commandsRun: [],
			diagnosticErrors: [],
			selfHealingAttempts: 0,
		};

		// 2a. Extract and write file blocks
		const fileBlocks = this._parseFileBlocks(responseText);
		for (const block of fileBlocks) {
			if (token.isCancellationRequested) { break; }
			try {
				await this._writeFileBlock(block);
				(result.filesWritten as string[]).push(block.path);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> ✅ **IDE Applied File:** \`${block.path}\`\n\n`)
				}]);

				// Open in editor
				try {
					const uri = this._resolveUri(block.path);
					await this._editorService.openEditor({ resource: uri });
				} catch {
					// Non-fatal: couldn't open in editor
				}
			} catch (err) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> ❌ **IDE File Write Failed:** \`${block.path}\`: ${err instanceof Error ? err.message : String(err)}\n\n`)
				}]);
			}
		}

		// 2b. Extract and emit command blocks (command execution happens via tool calls)
		const cmdBlocks = this._parseCmdBlocks(responseText);
		for (const cmd of cmdBlocks) {
			if (token.isCancellationRequested) { break; }
			(result.commandsRun as string[]).push(cmd.command);
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> 🖥️ **IDE Queued Command:** \`${cmd.command}\`\n\n`)
			}]);
		}

		return result;
	}

	// ─────────────────────────────────────────────────────────────────
	// Phase 3: Self-Healing Diagnostics Loop
	// ─────────────────────────────────────────────────────────────────

	/**
	 * Waits for diagnostics to settle, then checks IMarkerService for
	 * compiler/syntax errors in the written files.
	 * Returns the list of errors found, or empty if all clear.
	 */
	async checkDiagnostics(
		writtenFiles: string[],
		progress: (parts: IChatProgress[]) => void,
	): Promise<IDiagnosticError[]> {
		// Wait for the language service to process
		await this._delay(IDEExecutionOrchestrator.DIAGNOSTICS_WAIT_MS);

		const errors: IDiagnosticError[] = [];
		for (const filePath of writtenFiles) {
			const uri = this._resolveUri(filePath);
			const markers = this._markerService.read({ resource: uri });
			for (const marker of markers) {
				if (marker.severity === MarkerSeverity.Error) {
					errors.push({
						file: filePath,
						line: marker.startLineNumber,
						column: marker.startColumn,
						message: marker.message,
						severity: 'Error',
					});
				}
			}
		}

		if (errors.length > 0) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(
					`> 🔴 **IDE Compiler Check:** Found ${errors.length} error(s) in modified files:\n` +
					errors.map(e => `>   • \`${e.file}:${e.line}:${e.column}\` — ${e.message}`).join('\n') +
					'\n\n'
				)
			}]);
		} else if (writtenFiles.length > 0) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> ✅ **IDE Compiler Check:** All ${writtenFiles.length} modified file(s) pass diagnostics\n\n`)
			}]);
		}

		return errors;
	}

	/**
	 * Builds a self-healing prompt for sending back to Ollama with exact error details.
	 */
	buildSelfHealingPrompt(errors: IDiagnosticError[], attempt: number): string {
		const errorReport = errors.map(e =>
			`File: ${e.file}, Line ${e.line}:${e.column}\nError: ${e.message}`
		).join('\n\n');

		return (
			`[IDE Self-Healing Diagnostics — Attempt ${attempt}/${IDEExecutionOrchestrator.MAX_SELF_HEAL_RETRIES}]\n\n` +
			`The IDE compiler/linter check found the following errors in files you just generated.\n` +
			`Fix EACH error below and output the corrected file(s) using the // filepath: format.\n\n` +
			`--- ERRORS ---\n${errorReport}\n--- END ERRORS ---\n\n` +
			`Output ONLY the corrected file blocks. Do not explain.`
		);
	}

	/**
	 * Returns the maximum number of self-heal retries allowed.
	 */
	get maxSelfHealRetries(): number {
		return IDEExecutionOrchestrator.MAX_SELF_HEAL_RETRIES;
	}

	// ─── Private helpers ────────────────────────────────────────────

	private _parseFileBlocks(text: string): IFileBlock[] {
		const blocks: IFileBlock[] = [];
		const seen = new Set<string>();

		const addBlock = (rawPath: string, rawContent: string): void => {
			const cleanPath = rawPath.trim().replace(/^['"]|['"]$/g, '');
			const cleanContent = rawContent.trim();
			if (cleanPath && cleanContent && !seen.has(cleanPath)) {
				seen.add(cleanPath);
				blocks.push({ path: cleanPath, content: cleanContent });
			}
		};

		// Pattern 1: // filepath: path\n<code>
		let match: RegExpExecArray | null;
		const regex1 = new RegExp(IDEExecutionOrchestrator.FILE_BLOCK_REGEX.source, 'gi');
		while ((match = regex1.exec(text)) !== null) {
			addBlock(match[1], match[2]);
		}

		// Pattern 2: <ofcode_file path="...">...</ofcode_file> or <file path="...">
		const xmlRegex = /<(?:ofcode_file|file)\s+(?:path|name)="([^"]+)">([\s\S]*?)<\/(?:ofcode_file|file)>/gi;
		while ((match = xmlRegex.exec(text)) !== null) {
			addBlock(match[1], match[2]);
		}

		// Pattern 3: Code blocks with filename in fence
		// e.g. ```html:index.html or ```html filename="index.html"
		const fenceWithFilenameRegex = /```[a-zA-Z0-9_-]*(?::|\s+(?:filename|file|path)=["']?)([^\s\n"'>]+)["']?\s*\n([\s\S]*?)```/g;
		while ((match = fenceWithFilenameRegex.exec(text)) !== null) {
			addBlock(match[1], match[2]);
		}

		// Pattern 4: Code blocks with leading comment indicating filename
		// e.g. ```html\n<!-- index.html --> or ```css\n/* style.css */ or ```js\n// script.js
		const fenceWithCommentRegex = /```(?:html|css|js|javascript|ts|typescript|py|python|json|jsx|tsx)?\s*\n(?:\s*(?:\/\/|#|\/\*|<!--)\s*([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)(?:\s*\*\/|-->)?)\s*\n([\s\S]*?)```/g;
		while ((match = fenceWithCommentRegex.exec(text)) !== null) {
			addBlock(match[1], match[2]);
		}

		// Pattern 5: Markdown heading/bold preceding code block
		// e.g. **index.html**:\n```html\n...``` or ### `style.css`\n```css\n...```
		const preHeadingRegex = /(?:###?\s*`?|\*\*|__)([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,5})(?:`?|\*\*|__):?\s*\n+```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g;
		while ((match = preHeadingRegex.exec(text)) !== null) {
			addBlock(match[1], match[2]);
		}

		// Pattern 6 (Fallback): If still NO file blocks were found, but the model output standalone markdown code blocks
		// (e.g. ```html, ```css, ```js), infer standard filenames so the user code is never lost!
		if (blocks.length === 0) {
			const genericFenceRegex = /```(html|css|javascript|js|typescript|ts|python|py)\s*\n([\s\S]*?)```/g;
			let htmlCount = 0;
			let cssCount = 0;
			let jsCount = 0;

			while ((match = genericFenceRegex.exec(text)) !== null) {
				const lang = match[1].toLowerCase();
				const content = match[2].trim();
				if (content.length > 20 && content.includes('\n')) {
					let inferredName = '';
					if (lang === 'html') {
						inferredName = htmlCount === 0 ? 'index.html' : `page${htmlCount + 1}.html`;
						htmlCount++;
					} else if (lang === 'css') {
						inferredName = cssCount === 0 ? 'style.css' : `styles${cssCount + 1}.css`;
						cssCount++;
					} else if (lang === 'javascript' || lang === 'js') {
						inferredName = jsCount === 0 ? 'script.js' : `script${jsCount + 1}.js`;
						jsCount++;
					} else if (lang === 'typescript' || lang === 'ts') {
						inferredName = 'index.ts';
					} else if (lang === 'python' || lang === 'py') {
						inferredName = 'app.py';
					}
					if (inferredName) {
						addBlock(inferredName, content);
					}
				}
			}
		}

		return blocks;
	}

	private _parseCmdBlocks(text: string): ICmdBlock[] {
		const blocks: ICmdBlock[] = [];
		let match: RegExpExecArray | null;
		const regex = new RegExp(IDEExecutionOrchestrator.CMD_REGEX.source, 'gi');
		while ((match = regex.exec(text)) !== null) {
			const command = match[1].trim();
			if (command) {
				blocks.push({ command });
			}
		}
		return blocks;
	}

	private async _writeFileBlock(block: IFileBlock): Promise<void> {
		const uri = this._resolveUri(block.path);
		const parentUri = dirname(uri);
		const parentExists = await this._fileService.exists(parentUri);
		if (!parentExists) {
			await this._fileService.createFolder(parentUri);
		}
		await this._fileService.writeFile(uri, VSBuffer.fromString(block.content));
	}

	private _resolveUri(pathStr: string): URI {
		if (pathStr.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(pathStr)) {
			return URI.file(pathStr);
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			const rootUri = folders[0].uri;
			const rootFolderName = (folders[0].name || rootUri.path.split('/').pop() || '').toLowerCase();
			let cleanPath = pathStr.replace(/^\.[/\\]+/, '');
			const normalized = cleanPath.replace(/\\/g, '/');
			if (rootFolderName && normalized.toLowerCase().startsWith(`${rootFolderName}/`)) {
				cleanPath = cleanPath.substring(rootFolderName.length + 1);
			}
			return joinPath(rootUri, cleanPath);
		}
		return URI.file(pathStr);
	}

	private async _buildFileTree(uri: URI, lines: string[], depth: number, maxDepth: number): Promise<void> {
		if (depth > maxDepth) { return; }
		const stat = await this._fileService.resolve(uri, { resolveMetadata: false });
		if (!stat.children) { return; }

		const skip = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.turbo', '__pycache__']);
		const sorted = stat.children.slice().sort((a, b) => {
			if (a.isDirectory && !b.isDirectory) { return -1; }
			if (!a.isDirectory && b.isDirectory) { return 1; }
			return a.name.localeCompare(b.name);
		});

		const indent = '  '.repeat(depth + 1);
		for (const child of sorted) {
			if (skip.has(child.name)) {
				lines.push(`${indent}${child.name}/ [skipped]`);
				continue;
			}
			if (child.isDirectory) {
				lines.push(`${indent}${child.name}/`);
				await this._buildFileTree(child.resource, lines, depth + 1, maxDepth);
			} else {
				lines.push(`${indent}${child.name}`);
			}
		}
	}

	private _delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
