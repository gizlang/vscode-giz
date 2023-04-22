import * as vscode from 'vscode';
import { Range, StatusBarItem, TextEdit, OutputChannel, EndOfLine } from 'vscode';
import { execCmd } from './gizUtil';

export class GizFormatProvider implements vscode.DocumentFormattingEditProvider {
    private _channel: OutputChannel;

    constructor(logChannel: OutputChannel) {
        this._channel = logChannel;
    }

    provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options?: vscode.FormattingOptions,
        token?: vscode.CancellationToken,
    ): Thenable<TextEdit[]> {
        const logger = this._channel;
        return gizFormat(document)
            .then(({ stdout }) => {
                logger.clear();
                const lastLineId = document.lineCount - 1;
                const wholeDocument = new vscode.Range(
                    0,
                    0,
                    lastLineId,
                    document.lineAt(lastLineId).text.length,
                );
                return [new TextEdit(wholeDocument, stdout),];
            })
            .catch((reason) => {
                let config = vscode.workspace.getConfiguration('giz');

                logger.clear();
                logger.appendLine(reason.toString().replace('<stdin>', document.fileName));
                if (config.get<boolean>("revealOutputChannelOnFormattingError")) {
                    logger.show(true)
                }
                return null;
            });
    }
}

// Same as full document formatter for now
export class GizRangeFormatProvider implements vscode.DocumentRangeFormattingEditProvider {
    private _channel: OutputChannel;
    constructor(logChannel: OutputChannel) {
        this._channel = logChannel;
    }

    provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
        options?: vscode.FormattingOptions,
        token?: vscode.CancellationToken,
    ): Thenable<TextEdit[]> {
        const logger = this._channel;
        return gizFormat(document)
            .then(({ stdout }) => {
                logger.clear();
                const lastLineId = document.lineCount - 1;
                const wholeDocument = new vscode.Range(
                    0,
                    0,
                    lastLineId,
                    document.lineAt(lastLineId).text.length,
                );
                return [new TextEdit(wholeDocument, stdout),];
            })
            .catch((reason) => {
                const config = vscode.workspace.getConfiguration('giz');

                logger.clear();
                logger.appendLine(reason.toString().replace('<stdin>', document.fileName));
                if (config.get<boolean>("revealOutputChannelOnFormattingError")) {
                    logger.show(true)
                }
                return null;
            });
    }
}

function gizFormat(document: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('giz');
    const gizPath = config.get<string>('gizPath') || 'giz';

    const options = {
        cmdArguments: ['fmt', '--stdin'],
        notFoundText: 'Could not find giz. Please add giz to your PATH or specify a custom path to the giz binary in your settings.',
    };
    const format = execCmd(gizPath, options);

    format.stdin.write(document.getText());
    format.stdin.end();

    return format;
}
