/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOllamaModelTag } from './ollamaClient.js';

export type OllamaServerStatus = 'Running' | 'Stopped' | 'Starting';

export interface IOllamaModelConfig {
	readonly contextLength: number;
	readonly temperature: number;
	readonly serverUrl: string;
}

export const IOllamaServerManager = createDecorator<IOllamaServerManager>('ollamaServerManager');

export interface IOllamaServerManager {
	readonly _serviceBrand: undefined;

	readonly status: OllamaServerStatus;
	readonly onDidChangeStatus: Event<OllamaServerStatus>;

	readonly activeModel: string | undefined;
	readonly onDidChangeActiveModel: Event<string | undefined>;

	readonly config: IOllamaModelConfig;
	readonly onDidChangeConfig: Event<IOllamaModelConfig>;

	startServer(): Promise<void>;
	stopServer(): Promise<void>;
	restartServer(): Promise<void>;

	setActiveModel(modelName: string): Promise<void>;
	pullModel(modelName: string, onProgress?: (percent: number, status: string) => void): Promise<void>;
	unloadModel(modelName?: string): Promise<void>;
	configureParams(params: Partial<IOllamaModelConfig>): Promise<void>;
	getInstalledModels(): Promise<IOllamaModelTag[]>;
	refreshStatus(): Promise<OllamaServerStatus>;
}
