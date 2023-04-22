'use strict';
import * as vscode from 'vscode';
import GizCompilerProvider from './gizCompilerProvider';
import { gizBuild } from './gizBuild';
import { GizFormatProvider, GizRangeFormatProvider } from './gizFormat';
import { activate as activateZls, deactivate as deactivateZls } from './gls';

const GIZ_MODE: vscode.DocumentFilter = { language: 'giz', scheme: 'file' };

export let buildDiagnosticCollection: vscode.DiagnosticCollection;
export const logChannel = vscode.window.createOutputChannel('giz');
export const gizFormatStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

export function activate(context: vscode.ExtensionContext) {
    let compiler = new GizCompilerProvider();
    compiler.activate(context.subscriptions);
    vscode.languages.registerCodeActionsProvider('giz', compiler);

    context.subscriptions.push(logChannel);

    if (vscode.workspace.getConfiguration("giz").get<string>("formattingProvider", "gls") === "extension") {
        context.subscriptions.push(
            vscode.languages.registerDocumentFormattingEditProvider(
                GIZ_MODE,
                new GizFormatProvider(logChannel),
            ),
        );
        context.subscriptions.push(
            vscode.languages.registerDocumentRangeFormattingEditProvider(
                GIZ_MODE,
                new GizRangeFormatProvider(logChannel),
            ),
        );
    }

    buildDiagnosticCollection = vscode.languages.createDiagnosticCollection('giz');
    context.subscriptions.push(buildDiagnosticCollection);

    // Commands
    context.subscriptions.push(vscode.commands.registerCommand('giz.build.workspace', () => gizBuild()));

    activateZls(context);
}

export function deactivate() {
    deactivateZls();
}
