import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  onFallbackToCliMode?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  copied: boolean
}

/**
 * Chat-mode-only ErrorBoundary. When chat crashes, CLI mode stays functional.
 * Shows a recovery UI with "Switch to CLI mode" + "Retry chat" buttons
 * instead of white-screening the entire app.
 */
export class ChatErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, copied: false }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ChatErrorBoundary]', error, errorInfo)
    window.api?.log.error(`[ChatMode] ${error.message}`, error.stack)
  }

  handleCopy = () => {
    const err = this.state.error
    const text = `[Chat Mode Error]\n${err?.message || 'Unknown'}\n\n${err?.stack || ''}`
    navigator.clipboard.writeText(text).then(() => {
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    })
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        padding: 32,
      }}>
        <div style={{ fontSize: 48, opacity: 0.4 }}>⚠️</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Chat mode encountered an error</div>
        <div style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          maxWidth: 500,
          textAlign: 'center',
          lineHeight: 1.55,
        }}>
          {this.state.error?.message || 'An unexpected error occurred'}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button onClick={this.handleRetry} style={btnStyle('var(--accent)')}>
            Retry Chat Mode
          </button>
          {this.props.onFallbackToCliMode && (
            <button onClick={this.props.onFallbackToCliMode} style={btnStyle('var(--bg-tertiary)', true)}>
              Switch to CLI Mode
            </button>
          )}
          <button onClick={this.handleCopy} style={btnStyle('var(--bg-tertiary)', true)}>
            {this.state.copied ? 'Copied!' : 'Copy Error'}
          </button>
        </div>
      </div>
    )
  }
}

function btnStyle(bg: string, bordered = false): React.CSSProperties {
  return {
    padding: '10px 20px',
    borderRadius: 6,
    background: bg,
    color: bordered ? 'var(--text-primary)' : '#fff',
    border: bordered ? '1px solid var(--border)' : 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
  }
}
