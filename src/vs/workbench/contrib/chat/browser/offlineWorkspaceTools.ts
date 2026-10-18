/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { createToolSimpleTextResult } from '../common/tools/builtinTools/toolHelpers.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress, ILanguageModelToolsService } from '../common/tools/languageModelToolsService.js';
import { OfflineAgentToolId } from '../common/tools/offlineAgentTools/offlineAgentToolIds.js';

// ==========================================
// 1. ofcode_readFile
// ==========================================

export const ReadFileToolData: IToolData = {
	id: OfflineAgentToolId.ReadFile,
	toolReferenceName: 'read_file',
	displayName: localize('tool.readFile.displayName', 'Read Workspace File'),
	userDescription: localize('tool.readFile.userDescription', 'Reads the contents of a file in the workspace, with optional line range.'),
	modelDescription: 'Read the contents of any file in the workspace. Input: { path: string, startLine?: number, endLine?: number }',
	icon: ThemeIcon.fromId(Codicon.file.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Relative or absolute path of the file to read.' },
			startLine: { type: 'number', description: 'Optional 1-based start line number.' },
			endLine: { type: 'number', description: 'Optional 1-based end line number.' }
		},
		required: ['path']
	}
};

export class ReadFileTool extends Disposable implements IToolImpl {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService
	) {
		super();
	}

	private _resolveUri(pathStr: string): URI {
		if (pathStr.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(pathStr)) {
			return URI.file(pathStr);
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return joinPath(folders[0].uri, pathStr);
		}
		return URI.file(pathStr);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as { path?: string };
		return {
			invocationMessage: localize('tool.readFile.invoking', "Reading `{0}`...", input.path || '')
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as { path?: string; startLine?: number; endLine?: number };
		if (!input.path) {
			return createToolSimpleTextResult('Error: "path" parameter is required.');
		}
		const uri = this._resolveUri(input.path);
		try {
			const exists = await this._fileService.exists(uri);
			if (!exists) {
				return createToolSimpleTextResult(`File not found: ${input.path}`);
			}
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();
			const lines = text.split('\n');

			const start = Math.max(1, input.startLine ?? 1);
			const end = input.endLine ? Math.min(lines.length, input.endLine) : lines.length;

			const sliced = lines.slice(start - 1, end);
			const numbered = sliced.map((line, idx) => `${start + idx} | ${line}`).join('\n');
			return createToolSimpleTextResult(`File: ${input.path} (${lines.length} total lines)\n\`\`\`\n${numbered}\n\`\`\``);
		} catch (err) {
			return createToolSimpleTextResult(`Error reading ${input.path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ==========================================
// 2. ofcode_writeFile
// ==========================================

export const WriteFileToolData: IToolData = {
	id: OfflineAgentToolId.WriteFile,
	toolReferenceName: 'write_file',
	displayName: localize('tool.writeFile.displayName', 'Write Workspace File'),
	userDescription: localize('tool.writeFile.userDescription', 'Creates a new file or completely overwrites an existing file in the workspace.'),
	modelDescription: 'Create or overwrite a file in the workspace. Input: { path: string, content: string }',
	icon: ThemeIcon.fromId(Codicon.fileCode.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Relative or absolute path of the file to write.' },
			content: { type: 'string', description: 'Complete content to write into the file.' }
		},
		required: ['path', 'content']
	}
};

export class WriteFileTool extends Disposable implements IToolImpl {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService
	) {
		super();
	}

	private _resolveUri(pathStr: string): URI {
		if (pathStr.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(pathStr)) {
			return URI.file(pathStr);
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return joinPath(folders[0].uri, pathStr);
		}
		return URI.file(pathStr);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as { path?: string };
		return {
			invocationMessage: localize('tool.writeFile.invoking', "Writing `{0}`...", input.path || '')
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as { path?: string; content?: string };
		if (!input.path || input.content === undefined) {
			return createToolSimpleTextResult('Error: "path" and "content" parameters are required.');
		}
		const uri = this._resolveUri(input.path);
		try {
			const parent = dirname(uri);
			const parentExists = await this._fileService.exists(parent);
			if (!parentExists) {
				await this._fileService.createFolder(parent);
			}
			await this._fileService.writeFile(uri, VSBuffer.fromString(input.content));
			return createToolSimpleTextResult(`Successfully saved file '${input.path}' (${input.content.length} characters written).`);
		} catch (err) {
			return createToolSimpleTextResult(`Error writing file ${input.path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ==========================================
// 3. ofcode_editFile
// ==========================================

export const EditFileToolData: IToolData = {
	id: OfflineAgentToolId.EditFile,
	toolReferenceName: 'edit_file',
	displayName: localize('tool.editFile.displayName', 'Edit / Patch File'),
	userDescription: localize('tool.editFile.userDescription', 'Replaces an exact snippet of code in an existing file.'),
	modelDescription: 'Edit an existing file by replacing an exact oldSnippet with a newSnippet. Input: { path: string, oldSnippet: string, newSnippet: string }',
	icon: ThemeIcon.fromId(Codicon.edit.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Relative or absolute path of the file to edit.' },
			oldSnippet: { type: 'string', description: 'The exact string snippet currently in the file to replace.' },
			newSnippet: { type: 'string', description: 'The replacement string snippet.' }
		},
		required: ['path', 'oldSnippet', 'newSnippet']
	}
};

export class EditFileTool extends Disposable implements IToolImpl {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService
	) {
		super();
	}

	private _resolveUri(pathStr: string): URI {
		if (pathStr.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(pathStr)) {
			return URI.file(pathStr);
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return joinPath(folders[0].uri, pathStr);
		}
		return URI.file(pathStr);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as { path?: string };
		return {
			invocationMessage: localize('tool.editFile.invoking', "Patching `{0}`...", input.path || '')
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as { path?: string; oldSnippet?: string; newSnippet?: string };
		if (!input.path || input.oldSnippet === undefined || input.newSnippet === undefined) {
			return createToolSimpleTextResult('Error: "path", "oldSnippet", and "newSnippet" are required.');
		}
		const uri = this._resolveUri(input.path);
		try {
			const exists = await this._fileService.exists(uri);
			if (!exists) {
				return createToolSimpleTextResult(`File not found: ${input.path}`);
			}
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();

			let updated: string;
			if (text.includes(input.oldSnippet)) {
				updated = text.replace(input.oldSnippet, input.newSnippet);
			} else {
				const normText = text.replace(/\r\n/g, '\n');
				const normOld = input.oldSnippet.replace(/\r\n/g, '\n');
				if (normText.includes(normOld)) {
					updated = normText.replace(normOld, input.newSnippet.replace(/\r\n/g, '\n'));
				} else {
					return createToolSimpleTextResult(`Error: oldSnippet was not found in '${input.path}'. Ensure oldSnippet matches existing file lines exactly.`);
				}
			}

			await this._fileService.writeFile(uri, VSBuffer.fromString(updated));
			return createToolSimpleTextResult(`Successfully edited '${input.path}'. Code block replaced.`);
		} catch (err) {
			return createToolSimpleTextResult(`Error editing file ${input.path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ==========================================
// 4. ofcode_listFiles
// ==========================================

export const ListFilesToolData: IToolData = {
	id: OfflineAgentToolId.ListFiles,
	toolReferenceName: 'list_files',
	displayName: localize('tool.listFiles.displayName', 'List Workspace Files'),
	userDescription: localize('tool.listFiles.userDescription', 'Lists directories and files in the workspace tree.'),
	modelDescription: 'Explore the workspace directory tree. Input: { path?: string, maxDepth?: number }',
	icon: ThemeIcon.fromId(Codicon.listTree.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Optional relative path to inspect. Defaults to workspace root.' },
			maxDepth: { type: 'number', description: 'Max traversal depth (default: 3).' }
		}
	}
};

export class ListFilesTool extends Disposable implements IToolImpl {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService
	) {
		super();
	}

	private _resolveUri(pathStr?: string): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!pathStr || pathStr === '.' || pathStr === './') {
			return folders[0]?.uri;
		}
		if (pathStr.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(pathStr)) {
			return URI.file(pathStr);
		}
		if (folders.length > 0) {
			return joinPath(folders[0].uri, pathStr);
		}
		return URI.file(pathStr);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as { path?: string };
		return {
			invocationMessage: localize('tool.listFiles.invoking', "Listing files in `{0}`...", input.path || 'workspace')
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as { path?: string; maxDepth?: number };
		const maxDepth = input.maxDepth ?? 3;
		const folderUri = this._resolveUri(input.path);
		if (!folderUri) {
			return createToolSimpleTextResult('No workspace folder open.');
		}

		try {
			const lines: string[] = [];
			const traverse = async (uri: URI, depth: number, prefix: string): Promise<void> => {
				if (depth > maxDepth) {
					return;
				}
				const stat = await this._fileService.resolve(uri, { resolveMetadata: false });
				if (!stat.children) {
					return;
				}
				const sorted = stat.children.slice().sort((a, b) => {
					if (a.isDirectory && !b.isDirectory) { return -1; }
					if (!a.isDirectory && b.isDirectory) { return 1; }
					return a.name.localeCompare(b.name);
				});

				for (const child of sorted) {
					if (child.name === 'node_modules' || child.name === '.git' || child.name === 'out' || child.name === 'dist' || child.name === '.next' || child.name === '.turbo') {
						lines.push(`${prefix}📁 ${child.name}/ [skipped]`);
						continue;
					}
					if (child.isDirectory) {
						lines.push(`${prefix}📁 ${child.name}/`);
						await traverse(child.resource, depth + 1, prefix + '  ');
					} else {
						lines.push(`${prefix}📄 ${child.name}`);
					}
				}
			};

			lines.push(`Workspace Directory: ${folderUri.fsPath}`);
			await traverse(folderUri, 1, '  ');
			return createToolSimpleTextResult(lines.join('\n'));
		} catch (err) {
			return createToolSimpleTextResult(`List files error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ==========================================
// 5. ofcode_runCommand
// ==========================================

export const RunCommandToolData: IToolData = {
	id: OfflineAgentToolId.RunCommand,
	toolReferenceName: 'run_command',
	displayName: localize('tool.runCommand.displayName', 'Run Terminal Command'),
	userDescription: localize('tool.runCommand.userDescription', 'Executes shell commands in the integrated OFCode terminal.'),
	modelDescription: 'Execute a terminal command in the workspace. Input: { command: string }',
	icon: ThemeIcon.fromId(Codicon.terminal.id),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The terminal command line to execute.' }
		},
		required: ['command']
	}
};

export class RunCommandTool extends Disposable implements IToolImpl {
	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService
	) {
		super();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as { command?: string };
		return {
			invocationMessage: localize('tool.runCommand.invoking', "Running terminal command: `{0}`...", input.command || '')
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as { command?: string };
		if (!input.command || input.command.trim().length === 0) {
			return createToolSimpleTextResult('Error: Command parameter is required.');
		}

		try {
			let terminal: ITerminalInstance | undefined = this._terminalService.instances.find(t => t.title === 'OFCode Terminal' || t.title === 'OFCode Execution Terminal');
			if (!terminal || terminal.isDisposed) {
				terminal = await this._terminalService.createTerminal({
					config: {
						name: 'OFCode Terminal',
						isTransient: true,
					}
				});
				await terminal.processReady;
			}

			await this._terminalService.focusInstance(terminal);
			terminal.runCommand(input.command, true);

			return createToolSimpleTextResult(`Sent command to OFCode Terminal:\n\`\`\`bash\n${input.command}\n\`\`\`\nExecution launched successfully in integrated terminal.`);
		} catch (err) {
			return createToolSimpleTextResult(`Terminal execution error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ==========================================
// Contribution: Register all 5 tools
// ==========================================

export class OfflineWorkspaceToolsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.offlineWorkspaceTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const readFile = this._register(instantiationService.createInstance(ReadFileTool));
		this._register(toolsService.registerTool(ReadFileToolData, readFile));
		this._register(toolsService.vscodeToolSet.addTool(ReadFileToolData));

		const writeFile = this._register(instantiationService.createInstance(WriteFileTool));
		this._register(toolsService.registerTool(WriteFileToolData, writeFile));
		this._register(toolsService.vscodeToolSet.addTool(WriteFileToolData));

		const editFile = this._register(instantiationService.createInstance(EditFileTool));
		this._register(toolsService.registerTool(EditFileToolData, editFile));
		this._register(toolsService.vscodeToolSet.addTool(EditFileToolData));

		const listFiles = this._register(instantiationService.createInstance(ListFilesTool));
		this._register(toolsService.registerTool(ListFilesToolData, listFiles));
		this._register(toolsService.vscodeToolSet.addTool(ListFilesToolData));

		const runCommand = this._register(instantiationService.createInstance(RunCommandTool));
		this._register(toolsService.registerTool(RunCommandToolData, runCommand));
		this._register(toolsService.vscodeToolSet.addTool(RunCommandToolData));
	}
}
