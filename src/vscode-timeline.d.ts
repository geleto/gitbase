// Minimal ambient declarations for the VS Code Timeline API.
// The API is present at runtime since VS Code 1.44 but is absent from @types/vscode.

declare module 'vscode' {
  class TimelineItem {
    label:         string
    timestamp:     number
    id?:           string
    iconPath?:     ThemeIcon | Uri | { light: Uri; dark: Uri }
    description?:  string
    detail?:       string
    command?:      Command
    contextValue?: string
    tooltip?:      string | MarkdownString
    constructor(label: string, timestamp: number): TimelineItem
  }

  interface TimelineOptions {
    cursor?: string
    limit?:  number | { id: string }
  }

  interface Timeline {
    items:   TimelineItem[]
    paging?: { cursor?: string }
  }

  interface TimelineChangeEvent {
    uri?:   Uri
    reset?: boolean
  }

  interface TimelineProvider {
    id:           string
    label:        string
    onDidChange?: Event<TimelineChangeEvent | undefined>
    provideTimeline(uri: Uri, options: TimelineOptions, token: CancellationToken): ProviderResult<Timeline>
  }

  namespace workspace {
    function registerTimelineProvider(
      scheme:   DocumentSelector,
      provider: TimelineProvider,
    ): Disposable
  }
}
