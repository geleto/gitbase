import * as path from 'path'
import * as fs   from 'fs'
import * as vscode from 'vscode'
import Mocha from 'mocha'

function findTestFiles(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findTestFiles(full, results)
    else if (entry.isFile() && entry.name.endsWith('.test.js')) results.push(full)
  }
  return results
}

// VS Code 1.111.0 starts two extension hosts for every test run; both call
// run() simultaneously.  We use a per-process-group lock file so that only
// the FIRST host executes Mocha — the second one bails out immediately.
// Use a project-relative path so both the outer Node.js process (Git Bash,
// where os.tmpdir() = /tmp) and the Electron extension hosts (Windows,
// where os.tmpdir() = C:\Users\...\AppData\Local\Temp) resolve identically.
const LOCK = path.resolve(__dirname, '../../../.vscode-test/.test-runner.lock')

function tryAcquireLock(): boolean {
  try {
    // O_EXCL makes the open() fail if the file already exists → atomic
    const fd = fs.openSync(LOCK, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  } catch {
    // Another host already holds the lock
    return false
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK) } catch { /* ignore */ }
}

export async function run(): Promise<void> {
  if (!tryAcquireLock()) {
    // Second (or later) extension host — let the primary one handle testing.
    console.log('[GitBase Tests] Secondary extension host detected — skipping test runner.')
    return
  }

  const out = vscode.window.createOutputChannel('GitBase Tests')
  out.show(true)

  const mocha     = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 })
  const testsRoot = path.resolve(__dirname)

  for (const file of findTestFiles(testsRoot)) {
    mocha.addFile(file)
  }

  return new Promise((resolve, reject) => {
    try {
      const runner = mocha.run(failures => {
        releaseLock()
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`))
        else resolve()
      })

      const { EVENT_SUITE_BEGIN, EVENT_TEST_PASS, EVENT_TEST_FAIL, EVENT_RUN_END } = Mocha.Runner.constants
      runner.on(EVENT_SUITE_BEGIN, (suite: Mocha.Suite) => {
        if (suite.title) out.appendLine(`\n${suite.title}`)
      })
      runner.on(EVENT_TEST_PASS, (test: Mocha.Test) => {
        out.appendLine(`  ✓ ${test.title}`)
      })
      runner.on(EVENT_TEST_FAIL, (test: Mocha.Test, err: Error) => {
        out.appendLine(`  ✗ ${test.title}`)
        out.appendLine(`    ${err.message}`)
      })
      runner.on(EVENT_RUN_END, () => {
        const { passes, failures: f } = runner.stats!
        out.appendLine(`\n${passes} passing, ${f} failing`)
      })
    } catch (err) {
      releaseLock()
      reject(err)
    }
  })
}
