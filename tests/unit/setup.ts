// Intercepts require('vscode') so src modules that import vscode can be
// loaded in plain Node without a VS Code extension host.
// Must be --require'd by mocha before any test file.

import Module = require('module')

const _load = (Module as any)._load.bind(Module)

;(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockVscode
  return _load(request, ...rest)
}

const mockUri = (scheme: string, path: string, query: string, fragment: string) =>
  ({ scheme, path, query, fragment })

const mockVscode = {
  Uri: {
    from(c: { scheme?: string; path?: string; query?: string; fragment?: string }) {
      return mockUri(c.scheme ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '')
    },
    parse(str: string) {
      const i = str.indexOf(':')
      return mockUri(i >= 0 ? str.slice(0, i) : str, i >= 0 ? str.slice(i + 1) : '', '', '')
    },
  },
}
