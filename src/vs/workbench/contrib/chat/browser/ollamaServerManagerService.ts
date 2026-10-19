/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { ILanguageModelsService } from '../common/languageModels.js';
import { IOllamaModelTag, OllamaClient } from '../common/offlineAgent/ollamaClient.js';
import { IOllamaModelConfig, IOllamaServerManager, OllamaServerStatus } from '../common/offlineAgent/ollamaServerManager.js';
import { IChatWidgetService } from './chat.js';

const STORAGE_ACTIVE_MODEL_KEY = 'ofcode.ollama.activeModel';
const STORAGE_CONTEXT_LENGTH_KEY = 'ofcode.ollama.contextLength';
const STORAGE_TEMPERATURE_KEY = 'ofcode.ollama.temperature';
const STORAGE_SERVER_URL_KEY = 'ofcode.ollama.serverUrl';

export class OllamaServerManagerService extends Disposable implements IOllamaServerManager {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<OllamaServerStatus>());
	readonly onDidChangeStatus: Event<OllamaServerStatus> = this._onDidChangeStatus.event;

	private readonly _onDidChangeActiveModel = this._register(new Emitter<string | undefined>());
	readonly onDidChangeActiveModel: Event<string | undefined> = this._onDidChangeActiveModel.event;

	private readonly _onDidChangeConfig = this._register(new Emitter<IOllamaModelConfig>());
	readonly onDidChangeConfig: Event<IOllamaModelConfig> = this._onDidChangeConfig.event;

	private _status: OllamaServerStatus = 'Stopped';
	private _activeModel: string | undefined;
	private _config: IOllamaModelConfig;
	private readonly _client: OllamaClient;
	private _pollInterval: any;
	private _serverTerminal: ITerminalInstance | undefined;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
	) {
		super();

		const storedServerUrl = this._storageService.get(STORAGE_SERVER_URL_KEY, StorageScope.PROFILE, 'http://127.0.0.1:11434');
		const storedContext = this._storageService.getNumber(STORAGE_CONTEXT_LENGTH_KEY, StorageScope.PROFILE, 16384);
		const storedTemp = this._storageService.getNumber(STORAGE_TEMPERATURE_KEY, StorageScope.PROFILE, 0.2);
		this._activeModel = this._storageService.get(STORAGE_ACTIVE_MODEL_KEY, StorageScope.PROFILE, undefined);

		this._config = {
			serverUrl: storedServerUrl,
			contextLength: storedContext,
			temperature: storedTemp
		};

		this._client = new OllamaClient(this._config.serverUrl);

		// Initial check and start health polling
		this.refreshStatus();
		this._pollInterval = setInterval(() => this._pollHealth(), 5000);
		this._register({
			dispose: () => {
				clearInterval(this._pollInterval);
			}
		});
	}

	get status(): OllamaServerStatus {
		return this._status;
	}

	get activeModel(): string | undefined {
		return this._activeModel;
	}

	get config(): IOllamaModelConfig {
		return this._config;
	}

	private async _pollHealth(): Promise<void> {
		if (this._status === 'Starting') {
			return;
		}

		const isAlive = await this._client.isAlive();
		const prevStatus = this._status;
		const nextStatus: OllamaServerStatus = isAlive ? 'Running' : 'Stopped';

		if (prevStatus !== nextStatus) {
			this._status = nextStatus;
			this._onDidChangeStatus.fire(this._status);

			if (this._status === 'Running') {
				this._languageModelsService.selectLanguageModels({ vendor: 'ollama' }).catch(() => {});
				this._ensureActiveModel();
			}
		}
	}

	async refreshStatus(): Promise<OllamaServerStatus> {
		const isAlive = await this._client.isAlive();
		this._status = isAlive ? 'Running' : 'Stopped';
		this._onDidChangeStatus.fire(this._status);
		if (this._status === 'Running') {
			await this._ensureActiveModel();
		}
		return this._status;
	}

	private async _ensureActiveModel(): Promise<void> {
		if (!this._activeModel) {
			try {
				const models = await this._client.listModels();
				if (models.length > 0) {
					// Prioritize coder models (e.g. qwen2.5-coder) over generic models
					const coder = models.find(m => /coder|code/i.test(m.name));
					await this.setActiveModel(coder ? coder.name : models[0].name);
				}
			} catch {
				// Ignore if tags cannot be fetched
			}
		}
	}

	async startServer(): Promise<void> {
		if (this._status === 'Running') {
			this._notificationService.info(localize('ollamaAlreadyRunning', "Ollama server is already running on {0}", this._config.serverUrl));
			return;
		}

		this._status = 'Starting';
		this._onDidChangeStatus.fire(this._status);

		try {
			// Check if a terminal instance already exists
			let terminal = this._findExistingServerTerminal();
			if (!terminal) {
				terminal = await this._terminalService.createTerminal({
					config: {
						name: 'OFCode Ollama Server',
						isTransient: true,
						isFeatureTerminal: true,
					}
				});
				this._serverTerminal = terminal;
			}

			// Format start command with CORS wildcard
			const command = isWindows
				? '$env:OLLAMA_ORIGINS="*"; ollama serve'
				: 'OLLAMA_ORIGINS="*" ollama serve';

			terminal.sendText(command, true);

			// Poll for server availability up to 15 seconds
			const maxAttempts = 30;
			let started = false;
			for (let i = 0; i < maxAttempts; i++) {
				await new Promise(r => setTimeout(r, 500));
				if (await this._client.isAlive()) {
					started = true;
					break;
				}
			}

			if (started) {
				this._status = 'Running';
				this._onDidChangeStatus.fire(this._status);
				await this._languageModelsService.selectLanguageModels({ vendor: 'ollama' });
				await this._ensureActiveModel();
				this._notificationService.info(localize('ollamaStartedSuccess', "Ollama Server started successfully with CORS enabled."));
			} else {
				this._status = 'Stopped';
				this._onDidChangeStatus.fire(this._status);
				this._notificationService.warn(localize('ollamaStartTimeout', "Ollama server command was sent, but the server did not respond within 15 seconds. Check the 'OFCode Ollama Server' terminal."));
			}
		} catch (err) {
			this._status = 'Stopped';
			this._onDidChangeStatus.fire(this._status);
			this._notificationService.error(localize('ollamaStartError', "Failed to start Ollama server: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private _findExistingServerTerminal(): ITerminalInstance | undefined {
		if (this._serverTerminal && !this._serverTerminal.isDisposed) {
			return this._serverTerminal;
		}
		for (const instance of this._terminalService.instances) {
			if (instance.title === 'OFCode Ollama Server' && !instance.isDisposed) {
				this._serverTerminal = instance;
				return instance;
			}
		}
		return undefined;
	}

	async stopServer(): Promise<void> {
		this._status = 'Stopped';
		this._onDidChangeStatus.fire(this._status);

		const terminal = this._findExistingServerTerminal();
		if (terminal) {
			terminal.dispose();
			this._serverTerminal = undefined;
		}

		// Also send termination command in a quick helper if on windows
		if (isWindows) {
			try {
				const killTerminal = await this._terminalService.createTerminal({
					config: {
						name: 'Ollama Stop Helper',
						isTransient: true,
						isFeatureTerminal: true,
					}
				});
				killTerminal.sendText('taskkill /F /IM ollama.exe /T; exit', true);
				setTimeout(() => killTerminal.dispose(), 2000);
			} catch {
				// Ignore helper kill failure
			}
		}

		await new Promise(r => setTimeout(r, 1000));
		await this.refreshStatus();
		this._notificationService.info(localize('ollamaStopped', "Ollama server stopped."));
	}

	async restartServer(): Promise<void> {
		this._status = 'Starting';
		this._onDidChangeStatus.fire(this._status);

		const terminal = this._findExistingServerTerminal();
		if (terminal) {
			terminal.dispose();
			this._serverTerminal = undefined;
		}

		await new Promise(r => setTimeout(r, 1500));
		await this.startServer();
	}

	async setActiveModel(modelName: string): Promise<void> {
		const cleanName = this._client.normalizeModelName(modelName);
		this._activeModel = cleanName;
		this._storageService.store(STORAGE_ACTIVE_MODEL_KEY, cleanName, StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChangeActiveModel.fire(cleanName);

		// Synchronize active model with all open chat widgets
		const colonModelId = `ollama:${cleanName}`;
		const metadata = this._languageModelsService.lookupLanguageModel(colonModelId)
			?? this._languageModelsService.lookupLanguageModel(`ollama/${cleanName}`);

		if (metadata) {
			for (const widget of this._chatWidgetService.getAllWidgets()) {
				widget.input.setCurrentLanguageModel({
					identifier: colonModelId,
					metadata
				}, true, true);
			}
		}
	}

	async pullModel(modelName: string, onProgress?: (percent: number, status: string) => void): Promise<void> {
		const cleanName = this._client.normalizeModelName(modelName);
		await this._client.pullModel(cleanName, onProgress);
		await this._languageModelsService.selectLanguageModels({ vendor: 'ollama' });
		await this.setActiveModel(cleanName);
	}

	async unloadModel(modelName?: string): Promise<void> {
		const target = modelName || this._activeModel;
		if (!target) {
			throw new Error('No model specified to unload.');
		}
		const cleanName = this._client.normalizeModelName(target);
		await this._client.unloadModel(cleanName);
		this._notificationService.prompt(
			Severity.Info,
			localize('ollamaModelUnloaded', "Model '{0}' unloaded from memory/VRAM.", cleanName),
			[]
		);
	}

	async configureParams(params: Partial<IOllamaModelConfig>): Promise<void> {
		this._config = {
			...this._config,
			...params
		};

		if (params.serverUrl !== undefined) {
			this._storageService.store(STORAGE_SERVER_URL_KEY, this._config.serverUrl, StorageScope.PROFILE, StorageTarget.USER);
			this._client.setBaseUrl(this._config.serverUrl);
		}
		if (params.contextLength !== undefined) {
			this._storageService.store(STORAGE_CONTEXT_LENGTH_KEY, this._config.contextLength, StorageScope.PROFILE, StorageTarget.USER);
		}
		if (params.temperature !== undefined) {
			this._storageService.store(STORAGE_TEMPERATURE_KEY, this._config.temperature, StorageScope.PROFILE, StorageTarget.USER);
		}

		this._onDidChangeConfig.fire(this._config);
		await this.refreshStatus();
	}

	async getInstalledModels(): Promise<IOllamaModelTag[]> {
		if (this._status !== 'Running') {
			return [];
		}
		try {
			return await this._client.listModels();
		} catch (err) {
			this._logService.warn('Failed to query installed Ollama models:', err);
			return [];
		}
	}
}
