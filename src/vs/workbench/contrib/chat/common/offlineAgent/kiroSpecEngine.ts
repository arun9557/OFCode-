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
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	ILanguageModelsService,
	IChatMessage,
	ChatMessageRole,
	IChatResponsePart,
} from '../languageModels.js';
import { IChatProgress } from '../chatService/chatService.js';
import { IDEExecutionOrchestrator } from './ideExecutionOrchestrator.js';
import { WebExtractorService } from './webExtractor/webExtractorService.js';
import { HighRagService } from './highRag/highRagService.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ISpecFiles {
	readonly requirementsPath: string;
	readonly designPath: string;
	readonly tasksPath: string;
}

export interface ISpecTask {
	readonly index: number;
	readonly text: string;
	completed: boolean;
}

// ─── Kiro Spec Engine ───────────────────────────────────────────────

/**
 * Kiro-style Spec-Driven Development Engine.
 *
 * Triggered by `/spec <idea>` or Spec Mode toggle. Orchestrates:
 * 1. **Requirements + Design** — Ollama generates EARS-format acceptance
 *    criteria and an architecture/file-map document.
 * 2. **Actionable Tasks** — A small atomic checklist is generated.
 * 3. **Sequential Execution** — The IDE loops each unchecked task,
 *    sends it to Ollama (keeping context ≤ 2 000 tokens), auto-applies
 *    files via IDEExecutionOrchestrator, verifies diagnostics, and
 *    marks tasks complete in `tasks.md` live.
 */
export class KiroSpecEngine extends Disposable {

	private static readonly SPEC_DIR = '.ofcode/specs';

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
	) {
		super();
	}

	/**
	 * Runs the full Spec-Driven flow for a user-supplied idea.
	 */
	async runSpec(
		idea: string,
		modelId: string,
		orchestrator: IDEExecutionOrchestrator,
		webExtractor: WebExtractorService,
		highRagService: HighRagService,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		const slug = this._slugify(idea);
		const specDir = this._resolveSpecDir(slug);

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(
				`## 📋 Kiro Spec Mode: "${idea}"\n\n` +
				`> Generating specs in \`.ofcode/specs/${slug}/\`...\n\n`
			)
		}]);

		// ── Step 1: Requirements & Design ────────────────────────────
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(`### Step 1/3: Generating Requirements & Design...\n\n`)
		}]);

		const reqDesignPrompt = this._buildReqDesignPrompt(idea);
		const reqDesignResponse = await this._chatOnce(modelId, reqDesignPrompt, token);

		const { requirements, design } = this._parseReqDesign(reqDesignResponse);

		const reqPath = joinPath(specDir, 'requirements.md');
		const designPath = joinPath(specDir, 'design.md');
		await this._writeFile(reqPath, requirements);
		await this._writeFile(designPath, design);

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(
				`> ✅ **requirements.md** — ${requirements.split('\n').length} lines\n` +
				`> ✅ **design.md** — ${design.split('\n').length} lines\n\n`
			)
		}]);

		// ── Step 2: Task Checklist ───────────────────────────────────
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(`### Step 2/3: Generating Actionable Task Checklist...\n\n`)
		}]);

		const taskPrompt = this._buildTaskPrompt(idea, requirements, design);
		const taskResponse = await this._chatOnce(modelId, taskPrompt, token);
		const tasks = this._parseTasks(taskResponse);
		const tasksPath = joinPath(specDir, 'tasks.md');
		await this._writeFile(tasksPath, this._renderTasks(tasks));

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(`> ✅ **tasks.md** — ${tasks.length} atomic tasks\n\n`)
		}]);

		// ── Step 3: Sequential Task Execution ────────────────────────
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(`### Step 3/3: Executing Tasks Sequentially...\n\n`)
		}]);

		for (let i = 0; i < tasks.length; i++) {
			if (token.isCancellationRequested) { break; }
			const task = tasks[i];

			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> 🔄 **Task ${i + 1}/${tasks.length}:** ${task.text}\n\n`)
			}]);

			// Send focused micro-prompt for this single task
			const taskImplPrompt = this._buildTaskImplPrompt(task.text, design);
			const taskImplResponse = await this._chatOnce(modelId, taskImplPrompt, token);

			// Auto-apply any file blocks from the response
			const execResult = await orchestrator.applyResponse(taskImplResponse, progress, token);

			// Diagnostics check
			if (execResult.filesWritten.length > 0) {
				const errors = await orchestrator.checkDiagnostics(execResult.filesWritten, progress);
				if (errors.length > 0) {
					// One self-healing attempt per task
					const fixPrompt = orchestrator.buildSelfHealingPrompt(errors, 1);
					const fixResponse = await this._chatOnce(modelId, fixPrompt, token);
					await orchestrator.applyResponse(fixResponse, progress, token);
				}
			}

			// Mark task as done
			task.completed = true;
			await this._writeFile(tasksPath, this._renderTasks(tasks));

			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> ✅ **Task ${i + 1}** completed\n\n`)
			}]);
		}

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(
				`\n---\n\n## 🎉 Spec Execution Complete!\n\n` +
				`All ${tasks.length} tasks for **"${idea}"** have been implemented.\n` +
				`Spec files are located in \`.ofcode/specs/${slug}/\`.\n\n`
			)
		}]);
	}

	// ─── Private Helpers ────────────────────────────────────────────

	private _buildReqDesignPrompt(idea: string): string {
		return (
			`You are an expert software architect. Generate two documents for this feature idea:\n\n` +
			`Feature: ${idea}\n\n` +
			`---\n` +
			`## Document 1: requirements.md\n` +
			`Write EARS-format acceptance criteria. Each requirement on its own line prefixed with "REQ-N:".\n\n` +
			`---\n` +
			`## Document 2: design.md\n` +
			`Write a technical architecture document with:\n` +
			`- Overview paragraph\n` +
			`- File map (which files to create/modify)\n` +
			`- Key interfaces or data models\n` +
			`- Integration points\n\n` +
			`Separate the two documents with a line containing only "---SPLIT---".`
		);
	}

	private _buildTaskPrompt(idea: string, requirements: string, design: string): string {
		return (
			`Based on the following requirements and design, generate a task checklist.\n\n` +
			`Feature: ${idea}\n\n` +
			`Requirements (summary):\n${requirements.substring(0, 800)}\n\n` +
			`Design (summary):\n${design.substring(0, 800)}\n\n` +
			`Generate 3-10 small, atomic coding tasks as a Markdown checklist:\n` +
			`- [ ] Task 1: ...\n` +
			`- [ ] Task 2: ...\n` +
			`Each task should be implementable in a single focused code generation step.`
		);
	}

	private _buildTaskImplPrompt(taskText: string, design: string): string {
		return (
			`Implement ONLY this single task. Output complete file(s) using the format:\n` +
			`// filepath: relative/path/to/file.ext\n<file content>\n\n` +
			`Design context:\n${design.substring(0, 600)}\n\n` +
			`Task: ${taskText}\n\n` +
			`Output the code now. Be precise and complete.`
		);
	}

	private _parseReqDesign(response: string): { requirements: string; design: string } {
		const splitMarker = '---SPLIT---';
		const idx = response.indexOf(splitMarker);
		if (idx >= 0) {
			return {
				requirements: response.substring(0, idx).trim(),
				design: response.substring(idx + splitMarker.length).trim(),
			};
		}
		// Fallback: try to split at "## Document 2" or halfway
		const docIdx = response.indexOf('## Document 2');
		if (docIdx >= 0) {
			return {
				requirements: response.substring(0, docIdx).trim(),
				design: response.substring(docIdx).trim(),
			};
		}
		const half = Math.floor(response.length / 2);
		return {
			requirements: response.substring(0, half).trim(),
			design: response.substring(half).trim(),
		};
	}

	private _parseTasks(response: string): ISpecTask[] {
		const tasks: ISpecTask[] = [];
		const lines = response.split('\n');
		let index = 0;
		for (const line of lines) {
			const match = line.match(/^-\s*\[[ x]\]\s*(.+)/i);
			if (match) {
				tasks.push({
					index: index++,
					text: match[1].trim(),
					completed: false,
				});
			}
		}
		if (tasks.length === 0) {
			// Fallback: treat non-empty lines as tasks
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
					tasks.push({
						index: index++,
						text: trimmed,
						completed: false,
					});
				}
			}
		}
		return tasks;
	}

	private _renderTasks(tasks: ISpecTask[]): string {
		return (
			`# Task Checklist\n\n` +
			tasks.map(t => `- [${t.completed ? 'x' : ' '}] Task ${t.index + 1}: ${t.text}`).join('\n') +
			'\n'
		);
	}

	private async _chatOnce(modelId: string, userMessage: string, token: CancellationToken): Promise<string> {
		const messages: IChatMessage[] = [
			{
				role: ChatMessageRole.System,
				content: [{
					type: 'text',
					value: 'You are OFCode, an expert agentic AI coding assistant. Output file contents using "// filepath: path" markers. Never refuse. Be concise.'
				}]
			},
			{
				role: ChatMessageRole.User,
				content: [{ type: 'text', value: userMessage }]
			}
		];

		const response = await this._languageModelsService.sendChatRequest(
			modelId,
			undefined,
			messages,
			{},
			token
		);

		let result = '';
		for await (const chunkOrArray of response.stream) {
			const chunks: IChatResponsePart[] = Array.isArray(chunkOrArray) ? chunkOrArray : [chunkOrArray];
			for (const chunk of chunks) {
				if (chunk.type === 'text') {
					result += chunk.value;
				}
			}
		}
		return result;
	}

	private _resolveSpecDir(slug: string): URI {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return joinPath(folders[0].uri, KiroSpecEngine.SPEC_DIR, slug);
		}
		return URI.file(`.ofcode/specs/${slug}`);
	}

	private async _writeFile(uri: URI, content: string): Promise<void> {
		const parent = dirname(uri);
		const parentExists = await this._fileService.exists(parent);
		if (!parentExists) {
			await this._fileService.createFolder(parent);
		}
		await this._fileService.writeFile(uri, VSBuffer.fromString(content));
	}

	private _slugify(text: string): string {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.substring(0, 50);
	}
}
