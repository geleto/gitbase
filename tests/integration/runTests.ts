import * as path from 'path'
import * as fs   from 'fs'
import { runTests } from '@vscode/test-electron'

async function main(): Promise<void> {
  // ELECTRON_RUN_AS_NODE=1 is set by VS Code's own process (and inherited by
  // child shells / debug runners).  If we leave it set, Code.exe starts in
  // pure-Node mode and rejects every Electron/VS Code flag as a "bad option".
  delete process.env.ELECTRON_RUN_AS_NODE

  const extensionDevelopmentPath = path.resolve(__dirname, '../../../')
  const userDataDir = path.resolve(extensionDevelopmentPath, '.vscode-test/user-data')

  // Remove stale lock file from a previously crashed test run so the primary
  // extension host isn't mistakenly treated as secondary.
  // Use a project-relative path — identical whether this runs via Git Bash (os.tmpdir()=/tmp)
  // or via Electron extension hosts (os.tmpdir()=C:\Users\...\AppData\Local\Temp).
  const lockFile = path.join(extensionDevelopmentPath, '.vscode-test', '.test-runner.lock')
  try { fs.unlinkSync(lockFile) } catch { /* ignore if absent */ }

  // Wipe the entire user-data directory so VS Code doesn't restore stale workspace
  // folders from a previous run (which would open extra windows / start extra hosts).
  // We recreate just the settings.json we need immediately after.
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }

  // Ensure git.autoRepositoryDetection = "subFolders" so VS Code's git extension
  // scans ALL workspace folders (not just those with open editors, which is the
  // default since VS Code 1.84).  Without this, addWorkspaceFolder() never
  // triggers onDidOpenRepository for the dynamically-added test repos.
  const settingsDir  = path.join(userDataDir, 'User')
  const settingsFile = path.join(settingsDir, 'settings.json')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify({
    // true = "all": scan every workspace folder root AND its subfolders.
    'git.autoRepositoryDetection': true,
    'git.enabled': true,
    // VS Code 1.111 guards against opening repos "outside" the main workspace.
    // Test repos live in os.tmpdir(), which is outside c:\Projects\gitbase.
    // "always" bypasses the isRepositoryOutsideWorkspace check entirely so
    // every repo added via updateWorkspaceFolders is unconditionally opened.
    'git.openRepositoryInParentFolders': 'always',
    // Disable workspace trust so repos in os.tmpdir() are not blocked by the
    // requestResourceTrust() call inside git extension's openRepository().
    'security.workspace.trust.enabled': false,
  }, null, 2))

  // Use the project root as the workspace — it has a .git folder which triggers
  // vscode.git initialisation and the workspaceContains:.git activation event.
  const extensionTestsPath = path.resolve(__dirname, './index')

  // file:// URI for the workspace folder (required on Windows — bare paths are
  // treated as scripts by Electron's node runtime, not as folders to open).
  const workspaceUri = 'file:///' + extensionDevelopmentPath.replace(/\\/g, '/')

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // Pin userDataDir so the wipe above and VS Code's actual storage are the same path.
    // Without this, @vscode/test-electron picks its own default and stale workspace
    // folders accumulate there, causing extra VS Code windows on each run.
    launchArgs: [
      `--folder-uri=${workspaceUri}`,
      `--user-data-dir=${userDataDir}`,
    ],
  })
}

main().catch(err => {
  console.error('Failed to run integration tests:', err)
  process.exit(1)
})
