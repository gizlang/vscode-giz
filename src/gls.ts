import { workspace, ExtensionContext, window } from 'vscode';

import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import axios from 'axios';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import which from 'which';
import { mkdirp } from 'mkdirp';
import * as child_process from 'child_process';
import camelCase from 'camelcase';

export let outputChannel: vscode.OutputChannel;
export let client: LanguageClient | null = null;

export const downloadsRoot = 'https://giz.pm/gls/downloads';

/* eslint-disable @typescript-eslint/naming-convention */
export enum InstallationName {
  x86_linux = 'x86-linux',
  x86_windows = 'x86-windows',
  x86_64_linux = 'x86_64-linux',
  x86_64_macos = 'x86_64-macos',
  x86_64_windows = 'x86_64-windows',
  arm_64_macos = 'aarch64-macos',
  arm_64_linux = 'aarch64-linux',
}
/* eslint-enable @typescript-eslint/naming-convention */

export function getDefaultInstallationName(): InstallationName | null {
  // NOTE: Not using a JS switch because they're very clunky :(

  const plat = process.platform;
  const arch = process.arch;
  if (arch === 'ia32') {
    if (plat === 'linux') return InstallationName.x86_linux;
    else if (plat === 'win32') return InstallationName.x86_windows;
  } else if (arch === 'x64') {
    if (plat === 'linux') return InstallationName.x86_64_linux;
    else if (plat === 'darwin') return InstallationName.x86_64_macos;
    else if (plat === 'win32') return InstallationName.x86_64_windows;
  } else if (arch === 'arm64') {
    if (plat === 'darwin') return InstallationName.arm_64_macos;
    if (plat === 'linux') return InstallationName.arm_64_linux;
  }

  return null;
}

export async function installExecutable(context: ExtensionContext): Promise<string | null> {
  const def = getDefaultInstallationName();
  if (!def) {
    window.showInformationMessage(
      `Your system isn"t built by our CI!\nPlease follow the instructions [here](https://github.com/gizlang/gls#from-source) to get started!`,
    );
    return null;
  }

  return window.withProgress(
    {
      title: 'Installing gls...',
      location: vscode.ProgressLocation.Notification,
    },
    async (progress) => {
      progress.report({ message: 'Downloading gls executable...' });
      const exe = (
        await axios.get(`${downloadsRoot}/${def}/bin/gls${def.endsWith('windows') ? '.exe' : ''}`, {
          responseType: 'arraybuffer',
        })
      ).data;

      progress.report({ message: 'Installing...' });
      const installDir = vscode.Uri.joinPath(context.globalStorageUri, 'gls_install');
      if (!fs.existsSync(installDir.fsPath)) mkdirp.sync(installDir.fsPath);

      const glsBinPath = vscode.Uri.joinPath(installDir, `gls${def.endsWith('windows') ? '.exe' : ''}`).fsPath;
      const glsBinTempPath = glsBinPath + '.tmp';

      // Create a new executable file.
      // Do not update the existing file in place, to avoid code-signing crashes on macOS.
      // https://developer.apple.com/documentation/security/updating_mac_software
      fs.writeFileSync(glsBinTempPath, exe, 'binary');
      fs.chmodSync(glsBinTempPath, 0o755);
      fs.renameSync(glsBinTempPath, glsBinPath);

      let config = workspace.getConfiguration('giz.gls');
      await config.update('path', glsBinPath, true);

      return glsBinPath;
    },
  );
}

export async function checkUpdateMaybe(context: ExtensionContext) {
  const configuration = workspace.getConfiguration('giz.gls');
  const checkForUpdate = configuration.get<boolean>('checkForUpdate', true);
  if (checkForUpdate) {
    try {
      await checkUpdate(context, true);
    } catch (err: any) {
      outputChannel.appendLine(`Failed to check for update. Reason: ${err.message}`);
    }
  }
}

export async function startClient(context: ExtensionContext) {
  const configuration = workspace.getConfiguration('giz.gls');
  const debugLog = configuration.get<boolean>('debugLog', false);

  const glsPath = await getGLSPath(context);

  if (!glsPath) {
    promptAfterFailure(context);
    return null;
  }

  let serverOptions: ServerOptions = {
    command: glsPath,
    args: debugLog ? ['--enable-debug-log'] : [],
  };

  // Options to control the language client
  let clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'giz' }],
    outputChannel,
    middleware: {
      workspace: {
        async configuration(params, token, next) {
          let indexOfAstCheck = null;

          for (const [index, param] of Object.entries(params.items)) {
            if (param.section === 'gls.giz_exe_path') {
              param.section = `giz.gizPath`;
            } else if (param.section === 'gls.enable_ast_check_diagnostics') {
              indexOfAstCheck = index;
            } else {
              param.section = `giz.gls.${camelCase(param.section.slice(4))}`;
            }
          }

          const result = await next(params, token);

          if (indexOfAstCheck !== null) {
            result[indexOfAstCheck] =
              workspace.getConfiguration('giz').get<string>('astCheckProvider', 'gls') === 'gls';
          }

          return result;
        },
      },
    },
  };

  // Create the language client and start the client.
  client = new LanguageClient('gls', 'Giz Language Server', serverOptions, clientOptions);

  return client
    .start()
    .catch((reason) => {
      window.showWarningMessage(`Failed to run Giz Language Server (GLS): ${reason}`);
      client = null;
    })
    .then(() => {
      if (workspace.getConfiguration('giz').get<string>('formattingProvider', 'gls') !== 'gls')
        client.getFeature('textDocument/formatting').dispose();
    });
}

export async function stopClient(): Promise<void> {
  if (client) client.stop();
  client = null;
}

export async function promptAfterFailure(context: ExtensionContext): Promise<string | null> {
  const configuration = workspace.getConfiguration('giz.gls');
  const response = await window.showWarningMessage(
    "Couldn't find Giz Language Server (GLS) executable",
    'Install GLS',
    'Specify Path',
  );

  if (response === 'Install GLS') {
    return await installExecutable(context);
  } else if (response === 'Specify Path') {
    const uris = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Select Giz Language Server (GLS) executable',
    });

    if (uris) {
      await configuration.update('path', uris[0].path, true);
      return uris[0].path;
    }
  }

  return null;
}

// returns the file system path to the gls executable
export async function getGLSPath(context: ExtensionContext): Promise<string | null> {
  const configuration = workspace.getConfiguration('giz.gls');
  var glsPath = configuration.get<string | null>('path', null);

  // Allow passing the ${workspaceFolder} predefined variable
  // See https://code.visualstudio.com/docs/editor/variables-reference#_predefined-variables
  if (glsPath && glsPath.includes('${workspaceFolder}')) {
    // We choose the first workspaceFolder since it is ambiguous which one to use in this context
    if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
      // older versions of Node (which VSCode uses) may not have String.prototype.replaceAll
      glsPath = glsPath.replace(/\$\{workspaceFolder\}/gm, workspace.workspaceFolders[0].uri.fsPath);
    }
  }

  if (!glsPath) {
    glsPath = which.sync('gls', { nothrow: true });
  } else if (glsPath.startsWith('~')) {
    glsPath = path.join(os.homedir(), glsPath.substring(1));
  } else if (!path.isAbsolute(glsPath)) {
    glsPath = which.sync(glsPath, { nothrow: true });
  }

  var message: string | null = null;

  const glsPathExists = glsPath !== null && fs.existsSync(glsPath);
  if (glsPath && glsPathExists) {
    try {
      fs.accessSync(glsPath, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      message = `\`gls.path\` ${glsPath} is not an executable`;
    }
    const stat = fs.statSync(glsPath);
    if (!stat.isFile()) {
      message = `\`gls.path\` ${glsPath} is not a file`;
    }
  }

  if (message === null) {
    if (!glsPath) {
      return null;
    } else if (!glsPathExists) {
      message = `Couldn't find Giz Language Server (GLS) executable at "${glsPath.replace(/"/gm, '\\"')}"`;
    }
  }

  if (message) {
    await window.showErrorMessage(message);
    return null;
  }

  return glsPath;
}

export async function checkUpdate(context: ExtensionContext, autoInstallPrebuild: boolean): Promise<void> {
  const configuration = workspace.getConfiguration('giz.gls');

  const glsPath = await getGLSPath(context);
  if (!glsPath) return;

  if (!(await isUpdateAvailable(glsPath))) return;

  const isPrebuild = await isGLSPrebuildBinary(context);

  if (autoInstallPrebuild && isPrebuild) {
    await installExecutable(context);
  } else {
    const message = `There is a new update available for GLS. ${
      !isPrebuild ? 'It would replace your installation with a prebuilt binary.' : ''
    }`;
    const response = await window.showInformationMessage(message, 'Install update', 'Never ask again');

    if (response === 'Install update') {
      await installExecutable(context);
    } else if (response === 'Never ask again') {
      await configuration.update('checkForUpdate', false, true);
    }
  }
}

// checks whether gls has been installed with `installExecutable`
export async function isGLSPrebuildBinary(context: ExtensionContext): Promise<boolean> {
  const configuration = workspace.getConfiguration('giz.gls');
  var glsPath = configuration.get<string | null>('path', null);
  if (!glsPath) return false;

  const glsBinPath = vscode.Uri.joinPath(context.globalStorageUri, 'gls_install', 'gls').fsPath;
  return glsPath.startsWith(glsBinPath);
}

// checks whether there is newer version on master
export async function isUpdateAvailable(glsPath: string): Promise<boolean | null> {
  // get current version
  const buffer = child_process.execFileSync(glsPath, ['--version']);
  const version = parseVersion(buffer.toString('utf8'));
  if (!version) return null;

  // compare version triple if commit id is available
  if (version.commitHeight === null || version.commitHash === null) {
    // get latest tagged version
    const tagsResponse = await axios.get('https://api.github.com/repos/giztools/gls/tags');
    const latestVersion = parseVersion(tagsResponse.data[0].name);
    if (!latestVersion) return null;

    if (latestVersion.major < version.major) return false;
    if (latestVersion.major > version.major) return true;
    if (latestVersion.minor < version.minor) return false;
    if (latestVersion.minor > version.minor) return true;
    if (latestVersion.patch < version.patch) return false;
    if (latestVersion.patch > version.patch) return true;
    return false;
  }

  const response = await axios.get('https://api.github.com/repos/giztools/gls/commits/master');
  const masterHash: string = response.data.sha;

  const isMaster = masterHash.startsWith(version.commitHash);

  return !isMaster;
}

export interface Version {
  major: number;
  minor: number;
  patch: number;
  commitHeight: number | null;
  commitHash: string | null;
}

export function parseVersion(str: string): Version | null {
  const matches = /(\d+)\.(\d+)\.(\d+)(-dev\.(\d+)\+([0-9a-fA-F]+))?/.exec(str);
  //                  0   . 10   .  0  -dev .218   +d0732db
  //                                  (         optional          )?

  if (!matches) return null;
  if (matches.length !== 4 && matches.length !== 7) return null;

  return {
    major: parseInt(matches[1]),
    minor: parseInt(matches[2]),
    patch: parseInt(matches[3]),
    commitHeight: matches.length === 7 ? parseInt(matches[5]) : null,
    commitHash: matches.length === 7 ? matches[6] : null,
  };
}

export async function openConfig(context: ExtensionContext): Promise<void> {
  const glsPath = await getGLSPath(context);
  if (!glsPath) return;

  const buffer = child_process.execFileSync(glsPath, ['--show-config-path']);
  const path: string = buffer.toString('utf8').trimEnd();
  await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
}

function isEnabled(): boolean {
  return workspace.getConfiguration('giz.gls', null).get<boolean>('enabled', true);
}

const glsDisabledMessage = "gls is not enabled; if you'd like to enable it, please set 'giz.gls.enabled' to true.";
export async function activate(context: ExtensionContext) {
  outputChannel = window.createOutputChannel('Giz Language Server');

  vscode.commands.registerCommand('giz.gls.install', async () => {
    if (!isEnabled()) {
      window.showErrorMessage(glsDisabledMessage);
      return;
    }

    await stopClient();
    await installExecutable(context);
  });

  vscode.commands.registerCommand('giz.gls.stop', async () => {
    if (!isEnabled()) {
      window.showErrorMessage(glsDisabledMessage);
      return;
    }

    await stopClient();
  });

  vscode.commands.registerCommand('giz.gls.startRestart', async () => {
    if (!isEnabled()) {
      window.showErrorMessage(glsDisabledMessage);
      return;
    }

    await stopClient();
    await checkUpdateMaybe(context);
    await startClient(context);
  });

  vscode.commands.registerCommand('giz.gls.openconfig', async () => {
    if (!isEnabled()) {
      window.showErrorMessage(glsDisabledMessage);
      return;
    }

    await openConfig(context);
  });

  vscode.commands.registerCommand('giz.gls.update', async () => {
    if (!isEnabled()) {
      window.showErrorMessage(glsDisabledMessage);
      return;
    }

    await stopClient();
    await checkUpdate(context, false);
    await startClient(context);
  });

  if (!isEnabled()) return;

  const configuration = workspace.getConfiguration('giz.gls', null);
  if (!configuration.get<string | null>('path', null)) {
    const response = await window.showInformationMessage(
      'We recommend enabling GLS (the Giz Language Server) for a better editing experience. Would you like to enable it? You can always change this later by modifying `giz.gls.enabled` in your settings.',
      'Enable',
      'Disable',
    );

    if (response === 'Enable') {
      await installExecutable(context);
    } else if (response === 'Disable') {
      await configuration.update('enabled', false, true);
      return;
    }
  }

  await checkUpdateMaybe(context);
  await startClient(context);
}

export function deactivate(): Thenable<void> {
  return stopClient();
}
