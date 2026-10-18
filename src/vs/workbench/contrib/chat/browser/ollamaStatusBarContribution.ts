/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { themeColorFromId } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgress, IProgressService, IProgressStep, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IOllamaServerManager } from '../common/offlineAgent/ollamaServerManager.js';

interface IOllamaActionItem extends IQuickPickItem {
	readonly action: 'start' | 'restart' | 'stop' | 'switchModel' | 'pullModel' | 'unloadModel' | 'configureParams';
	readonly modelName?: string;
}

export class OllamaStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.ollamaStatusBarContribution';

	private _statusbarEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IOllamaServerManager private readonly _serverManager: IOllamaServerManager,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();

		this._register(this._serverManager.onDidChangeStatus(() => this._updateStatusBar()));
		this._register(this._serverManager.onDidChangeActiveModel(() => this._updateStatusBar()));
		this._register(this._serverManager.onDidChangeConfig(() => this._updateStatusBar()));

		this._registerCommands();
		this._updateStatusBar();
	}

	private _formatContextLength(tokens: number): string {
		if (tokens >= 1024) {
			const k = Math.round(tokens / 1024);
			return `${k}k`;
		}
		return `${tokens}`;
	}

	private _updateStatusBar(): void {
		const status = this._serverManager.status;
		const activeModel = this._serverManager.activeModel;
		const config = this._serverManager.config;
		const ctxFormatted = this._formatContextLength(config.contextLength);

		let entryProps: IStatusbarEntry;

		if (status === 'Running') {
			const modelLabel = activeModel || 'No Model';
			entryProps = {
				name: localize('ollamaStatus', "Ollama Status"),
				text: `$(vm-running) Ollama: ${modelLabel} (${ctxFormatted})`,
				ariaLabel: `Ollama is running with model ${modelLabel}`,
				tooltip: localize('ollamaRunningTooltip', "Ollama Local Server: Running\nActive Model: {0} ({1} context)\nClick to open OFCode Ollama Control Center", modelLabel, ctxFormatted),
				command: 'ofcode.ollama.openControlCenter',
				kind: 'standard'
			};
		} else if (status === 'Starting') {
			entryProps = {
				name: localize('ollamaStatus', "Ollama Status"),
				text: `$(sync~spin) Ollama: Starting...`,
				ariaLabel: 'Ollama server is starting',
				tooltip: localize('ollamaStartingTooltip', "Ollama server is initializing... Click to view controls"),
				command: 'ofcode.ollama.openControlCenter',
				kind: 'standard'
			};
		} else {
			entryProps = {
				name: localize('ollamaStatus', "Ollama Status"),
				text: `$(error) Ollama: Offline (Click to Start)`,
				ariaLabel: 'Ollama is offline',
				tooltip: localize('ollamaOfflineTooltip', "Ollama is not running. Click to start the local Ollama server."),
				command: 'ofcode.ollama.openControlCenter',
				backgroundColor: themeColorFromId('statusBarItem.warningBackground')
			};
		}

		if (this._statusbarEntry) {
			this._statusbarEntry.update(entryProps);
		} else {
			this._statusbarEntry = this._statusbarService.addEntry(
				entryProps,
				'ofcode.ollama.status',
				StatusbarAlignment.RIGHT,
				100.05
			);
			this._register(this._statusbarEntry);
		}
	}

	private _registerCommands(): void {
		this._register(CommandsRegistry.registerCommand('ofcode.ollama.openControlCenter', () => {
			this._openControlCenter();
		}));

		this._register(CommandsRegistry.registerCommand('ofcode.ollama.startServer', () => {
			return this._serverManager.startServer();
		}));

		this._register(CommandsRegistry.registerCommand('ofcode.ollama.stopServer', () => {
			return this._serverManager.stopServer();
		}));

		this._register(CommandsRegistry.registerCommand('ofcode.ollama.restartServer', () => {
			return this._serverManager.restartServer();
		}));

		this._register(CommandsRegistry.registerCommand('ofcode.ollama.pullModel', () => {
			this._showPullModelPicker();
		}));

		this._register(CommandsRegistry.registerCommand('ofcode.ollama.unloadModel', () => {
			return this._serverManager.unloadModel();
		}));

		this._register(CommandsRegistry.registerCommand('ofcode.ollama.configureParams', () => {
			this._showConfigureParamsPicker();
		}));
	}

	private async _openControlCenter(): Promise<void> {
		const isRunning = this._serverManager.status === 'Running';
		const installedModels = await this._serverManager.getInstalledModels();
		const activeModel = this._serverManager.activeModel;
		const config = this._serverManager.config;

		const items: Array<IOllamaActionItem | { type: 'separator'; label: string }> = [];

		// --- Section 1: Server Controls ---
		items.push({ type: 'separator', label: localize('serverControlsHeader', "Server Controls") });
		if (!isRunning) {
			items.push({
				label: localize('startServerLabel', "$(play) Start Ollama Server (Auto-CORS)"),
				description: localize('startServerDesc', "Launch local server with OLLAMA_ORIGINS=*"),
				action: 'start'
			});
		} else {
			items.push({
				label: localize('restartServerLabel', "$(sync) Restart Ollama Server"),
				description: localize('restartServerDesc', "Cleanly reload Ollama process and rediscover models"),
				action: 'restart'
			});
			items.push({
				label: localize('stopServerLabel', "$(stop-circle) Stop Ollama Server"),
				description: localize('stopServerDesc', "Terminate background Ollama process"),
				action: 'stop'
			});
		}

		// --- Section 2: Installed Models ---
		if (isRunning && installedModels.length > 0) {
			items.push({ type: 'separator', label: localize('installedModelsHeader', "Switch Active Model") });
			for (const m of installedModels) {
				const isSelected = m.name === activeModel || m.name.replace(/^ollama[:/]/, '') === activeModel;
				const sizeGb = (m.size / (1024 * 1024 * 1024)).toFixed(1);
				const paramSize = m.details?.parameter_size || '';
				const quant = m.details?.quantization_level || '';
				const family = m.details?.family || '';

				items.push({
					label: isSelected ? `$(check) ${m.name}` : `$(symbol-variable) ${m.name}`,
					description: `${paramSize} • ${quant}`.trim(),
					detail: `Disk: ${sizeGb} GB • Family: ${family}`,
					action: 'switchModel',
					modelName: m.name
				});
			}
		}

		// --- Section 3: Model Operations ---
		items.push({ type: 'separator', label: localize('modelOpsHeader', "Model Operations") });
		items.push({
			label: localize('pullModelLabel', "$(cloud-download) Pull / Download New Model..."),
			description: localize('pullModelDesc', "Download models from Ollama library with live progress"),
			action: 'pullModel'
		});
		if (isRunning && activeModel) {
			items.push({
				label: localize('unloadModelLabel', "$(trash) Unload Model from RAM / GPU"),
				description: localize('unloadModelDesc', "Immediately release active weights from VRAM/RAM (keep_alive: 0)"),
				action: 'unloadModel'
			});
		}

		// --- Section 4: Configuration ---
		items.push({ type: 'separator', label: localize('configHeader', "Parameters & Configuration") });
		items.push({
			label: localize('configLabel', "$(gear) Configure Model Parameters..."),
			description: localize('configDesc', "Context: {0} • Temp: {1} • Host: {2}", this._formatContextLength(config.contextLength), config.temperature, config.serverUrl),
			action: 'configureParams'
		});

		const pick = await this._quickInputService.pick(items as IOllamaActionItem[], {
			placeHolder: localize('controlCenterPlaceholder', "OFCode Ollama Control Center - Status: {0}", this._serverManager.status),
			matchOnDescription: true,
			matchOnDetail: true
		});

		if (!pick) {
			return;
		}

		switch (pick.action) {
			case 'start':
				await this._serverManager.startServer();
				break;
			case 'stop':
				await this._serverManager.stopServer();
				break;
			case 'restart':
				await this._serverManager.restartServer();
				break;
			case 'switchModel':
				if (pick.modelName) {
					await this._serverManager.setActiveModel(pick.modelName);
					this._notificationService.info(localize('modelSwitched', "Active Ollama model switched to '{0}'", pick.modelName));
				}
				break;
			case 'pullModel':
				this._showPullModelPicker();
				break;
			case 'unloadModel':
				await this._serverManager.unloadModel();
				break;
			case 'configureParams':
				this._showConfigureParamsPicker();
				break;
		}
	}

	private async _showPullModelPicker(): Promise<void> {
		interface IPresetItem extends IQuickPickItem {
			modelTag?: string;
			custom?: boolean;
		}

		const presets: IPresetItem[] = [
			{
				label: '$(flame) qwen2.5-coder:7b',
				description: 'Recommended: High-performance coding agent with native tool-calling',
				detail: '4.7 GB • Q4_K_M • Great for 8GB+ RAM',
				modelTag: 'qwen2.5-coder:7b'
			},
			{
				label: '$(rocket) qwen2.5-coder:14b',
				description: 'Deep reasoning agentic coding & complex multi-file refactoring',
				detail: '9.0 GB • Q4_K_M • Great for 16GB+ RAM / GPU',
				modelTag: 'qwen2.5-coder:14b'
			},
			{
				label: '$(zap) llama3.2:3b',
				description: 'Ultra-fast lightweight assistant for quick tasks and completions',
				detail: '2.0 GB • Extremely fast response times',
				modelTag: 'llama3.2:3b'
			},
			{
				label: '$(code) deepseek-coder-v2',
				description: 'Advanced MoE coding model for complex algorithmic tasks',
				detail: '8.9 GB • MoE architecture',
				modelTag: 'deepseek-coder-v2'
			},
			{
				label: '$(database) nomic-embed-text',
				description: 'High-accuracy text embeddings for High-RAG symbol retrieval',
				detail: '274 MB • Embedding model',
				modelTag: 'nomic-embed-text'
			},
			{
				label: localize('customModelPick', "$(edit) Enter Custom Model Tag..."),
				description: 'Type any model tag from the Ollama library (e.g. mistral, codellama, phi3)',
				custom: true
			}
		];

		const selected = await this._quickInputService.pick(presets, {
			placeHolder: localize('pullModelPlaceholder', "Select a recommended model or type a custom model tag to pull:"),
			matchOnDescription: true,
			matchOnDetail: true
		});

		if (!selected) {
			return;
		}

		let targetModel = selected.modelTag;
		if (selected.custom) {
			const input = await this._quickInputService.input({
				prompt: localize('enterModelPrompt', "Enter the Ollama model tag to download:"),
				placeHolder: 'e.g. qwen2.5-coder:7b, llama3.2, deepseek-r1:8b',
				validateInput: async (val: string) => {
					if (!val || val.trim().length === 0) {
						return localize('invalidModelName', "Model name cannot be empty.");
					}
					return undefined;
				}
			});
			if (!input) {
				return;
			}
			targetModel = input.trim();
		}

		if (!targetModel) {
			return;
		}

		await this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('pullingTitle', "OFCode: Pulling '{0}'...", targetModel),
			cancellable: true
		}, async (progress: IProgress<IProgressStep>) => {
			let lastPercent = 0;
			try {
				await this._serverManager.pullModel(targetModel!, (percent, status) => {
					const increment = percent > lastPercent ? percent - lastPercent : 0;
					lastPercent = percent;
					progress.report({
						message: `${status} (${percent}%)`,
						increment
					});
				});
				this._notificationService.info(localize('pullSuccess', "Ollama model '{0}' downloaded successfully and set as active.", targetModel));
			} catch (err) {
				this._notificationService.error(localize('pullError', "Failed to pull '{0}': {1}", targetModel, err instanceof Error ? err.message : String(err)));
			}
		});
	}

	private async _showConfigureParamsPicker(): Promise<void> {
		const currentConfig = this._serverManager.config;

		interface IParamOption extends IQuickPickItem {
			param: 'num_ctx' | 'temperature' | 'serverUrl';
		}

		const options: IParamOption[] = [
			{
				label: localize('ctxLabel', "$(symbol-number) Context Window (num_ctx)"),
				description: `Current: ${currentConfig.contextLength} tokens (${this._formatContextLength(currentConfig.contextLength)})`,
				detail: 'Select memory limit for prompt and tool history',
				param: 'num_ctx'
			},
			{
				label: localize('tempLabel', "$(flame) Temperature"),
				description: `Current: ${currentConfig.temperature}`,
				detail: 'Controls randomness: 0.0 (precise code) to 0.7 (exploratory)',
				param: 'temperature'
			},
			{
				label: localize('urlLabel', "$(globe) Custom Ollama Server URL"),
				description: `Current: ${currentConfig.serverUrl}`,
				detail: 'Configure custom local or remote Ollama host',
				param: 'serverUrl'
			}
		];

		const selectedParam = await this._quickInputService.pick(options, {
			placeHolder: localize('chooseParamToConfigure', "Select parameter to configure:")
		});

		if (!selectedParam) {
			return;
		}

		if (selectedParam.param === 'num_ctx') {
			const ctxChoices: Array<IQuickPickItem & { val: number }> = [
				{ label: '4096 tokens (4k)', description: 'Lightweight - Best for 4GB VRAM', val: 4096 },
				{ label: '8192 tokens (8k)', description: 'Balanced - Suitable for most coding tasks', val: 8192 },
				{ label: '16384 tokens (16k)', description: 'Recommended - Full multi-file context & AST RAG', val: 16384 },
				{ label: '32768 tokens (32k)', description: 'Maximum - Large context for deep repositories (16GB+ RAM)', val: 32768 }
			];
			const picked = await this._quickInputService.pick(ctxChoices, {
				placeHolder: localize('selectContextSize', "Select Context Window Size (num_ctx):")
			});
			if (picked) {
				await this._serverManager.configureParams({ contextLength: picked.val });
				this._notificationService.info(localize('contextUpdated', "Ollama context window updated to {0} tokens.", picked.val));
			}
		} else if (selectedParam.param === 'temperature') {
			const tempChoices: Array<IQuickPickItem & { val: number }> = [
				{ label: '0.0', description: 'Deterministic / Strict - Best for syntax exactness and tool calling', val: 0.0 },
				{ label: '0.2', description: 'Default Balanced - Ideal for code generation and refactoring', val: 0.2 },
				{ label: '0.5', description: 'Creative - Good for conceptual discussion and planning', val: 0.5 },
				{ label: '0.7', description: 'Exploratory - Highly varied responses', val: 0.7 }
			];
			const picked = await this._quickInputService.pick(tempChoices, {
				placeHolder: localize('selectTemperature', "Select Temperature for model inference:")
			});
			if (picked) {
				await this._serverManager.configureParams({ temperature: picked.val });
				this._notificationService.info(localize('tempUpdated', "Ollama temperature updated to {0}.", picked.val));
			}
		} else if (selectedParam.param === 'serverUrl') {
			const newUrl = await this._quickInputService.input({
				prompt: localize('enterServerUrl', "Enter Ollama server endpoint:"),
				value: currentConfig.serverUrl,
				validateInput: async (val: string) => {
					if (!val || (!val.startsWith('http://') && !val.startsWith('https://'))) {
						return localize('invalidUrl', "URL must start with http:// or https://");
					}
					return undefined;
				}
			});
			if (newUrl) {
				await this._serverManager.configureParams({ serverUrl: newUrl.trim() });
				this._notificationService.info(localize('urlUpdated', "Ollama server URL updated to '{0}'.", newUrl.trim()));
			}
		}
	}
}
