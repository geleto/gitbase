import * as vscode from 'vscode'

let channel: vscode.OutputChannel | undefined

export function initOutputChannel(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel('GitBase')
  return channel
}

export function log(msg: string): void {
  channel?.appendLine(msg)
}
