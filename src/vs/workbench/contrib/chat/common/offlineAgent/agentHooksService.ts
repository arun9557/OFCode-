/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';

// ─── Agent Hooks Service ────────────────────────────────────────────

/**
 * Kiro-Style Event-Driven Agent Hooks.
 *
 * Listens to file save events (`ITextFileService.files.onDidSave`).
 * When Agent Hooks are enabled (toggleable from the status bar), if a
 * saved file has any error markers in `IMarkerService`, the service
 * can auto-suggest or silently queue a background fix using Ollama.
 *
 * This implementation provides the event infrastructure and hook
 * evaluation. Actual Ollama calls are dispatched by the consumer
 * (e.g. OfflineChatAgent) when it subscribes to `onHookTriggered`.
 */
export class AgentHooksService extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.agentHooksService';

	private static readonly ENABLED_KEY = 'ofcode.agentHooks.enabled';

	private _enabled: boolean;

	private readonly _onHookTriggered = this._register(new Emitter<IAgentHookEvent>());
	readonly onHookTriggered: Event<IAgentHookEvent> = this._onHookTriggered.event;

	private readonly _onDidChangeEnabled = this._register(new Emitter<boolean>());
	readonly onDidChangeEnabled: Event<boolean> = this._onDidChangeEnabled.event;

	constructor(
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();

		// Restore enabled state from storage
		this._enabled = this._storageService.getBoolean(
			AgentHooksService.ENABLED_KEY,
			StorageScope.PROFILE,
			false
		);

		// Listen for file saves
		this._register(this._textFileService.files.onDidSave(e => {
			if (this._enabled) {
				this._evaluateOnSave(e.model.resource);
			}
		}));
	}

	/**
	 * Whether Agent Hooks are currently enabled.
	 */
	get enabled(): boolean {
		return this._enabled;
	}

	/**
	 * Toggle Agent Hooks on or off.
	 */
	setEnabled(enabled: boolean): void {
		if (this._enabled === enabled) {
			return;
		}
		this._enabled = enabled;
		this._storageService.store(
			AgentHooksService.ENABLED_KEY,
			enabled,
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._onDidChangeEnabled.fire(enabled);
		this._notificationService.notify({
			severity: Severity.Info,
			message: enabled
				? 'OFCode Agent Hooks: Enabled — auto-fix on save is now active.'
				: 'OFCode Agent Hooks: Disabled — files will not be auto-checked on save.',
		});
	}

	/**
	 * Evaluates a saved file for error markers and hook rules.
	 */
	private _evaluateOnSave(resource: URI): void {
		// Small delay to let diagnostics settle after save
		setTimeout(() => {
			const markers = this._markerService.read({ resource });
			const errors = markers.filter(m => m.severity === MarkerSeverity.Error);

			if (errors.length > 0) {
				const errorSummary = errors.map(e =>
					`Line ${e.startLineNumber}:${e.startColumn} — ${e.message}`
				).join('\n');

				this._onHookTriggered.fire({
					type: 'diagnosticErrors',
					resource,
					errorCount: errors.length,
					errorSummary,
					message: `File "${resource.fsPath}" has ${errors.length} error(s) after save.`,
				});
			}

			// TODO: Evaluate .ofcode/hooks.json rules for custom triggers
			// This can be expanded to support custom hook rules like:
			//   { "onSave": { "glob": "*.ts", "action": "lint-fix" } }
		}, 500);
	}
}

// ─── Types ──────────────────────────────────────────────────────────

export interface IAgentHookEvent {
	readonly type: 'diagnosticErrors' | 'customRule';
	readonly resource: URI;
	readonly errorCount: number;
	readonly errorSummary: string;
	readonly message: string;
}
