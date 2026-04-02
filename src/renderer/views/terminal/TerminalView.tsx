import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { useSettingsStore, resolveTheme } from '../../stores/settings'

interface TerminalViewProps {
  ptyId: string | null
  isActive: boolean
  cwd?: string
  onFileClick?: (path: string) => void
}

const DARK_THEME = {
  background: '#191919',
  foreground: '#F0EDE8',
  cursor: '#8B7355',
  cursorAccent: '#191919',
  selectionBackground: 'rgba(139, 115, 85, 0.3)',
  black: '#191919',
  red: '#FC8181',
  green: '#68D391',
  yellow: '#ECC94B',
  blue: '#7AA2F7',
  magenta: '#BB9AF7',
  cyan: '#7DCFFF',
  white: '#F0EDE8',
  brightBlack: '#6B6B6B',
  brightRed: '#FC8181',
  brightGreen: '#68D391',
  brightYellow: '#ECC94B',
  brightBlue: '#7AA2F7',
  brightMagenta: '#BB9AF7',
  brightCyan: '#7DCFFF',
  brightWhite: '#FFFFFF'
}

const LIGHT_THEME = {
  background: '#FFFFFF',
  foreground: '#1A1A1A',
  cursor: '#8B7355',
  cursorAccent: '#FFFFFF',
  selectionBackground: 'rgba(139, 115, 85, 0.2)',
  black: '#1A1A1A',
  red: '#C53030',
  green: '#2E8B57',
  yellow: '#B8860B',
  blue: '#2563EB',
  magenta: '#7C3AED',
  cyan: '#0891B2',
  white: '#F0EFED',
  brightBlack: '#999999',
  brightRed: '#E53E3E',
  brightGreen: '#38A169',
  brightYellow: '#D69E2E',
  brightBlue: '#3B82F6',
  brightMagenta: '#8B5CF6',
  brightCyan: '#06B6D4',
  brightWhite: '#FFFFFF'
}

function getTermTheme(): typeof DARK_THEME {
  const theme = useSettingsStore.getState().theme
  return resolveTheme(theme) === 'light' ? LIGHT_THEME : DARK_THEME
}

function safeFit(container: HTMLDivElement | null, fitAddon: FitAddon | null) {
  if (!fitAddon || !container) return
  if (container.offsetWidth === 0 || container.offsetHeight === 0) return
  try {
    fitAddon.fit()
  } catch {
    // Ignore fit errors
  }
}

// File path pattern for link detection
const FILE_PATH_RE = /(?:^|\s|["'`(])([./~]?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|sh|md|json|yaml|yml|toml|css|scss|html|sql|c|cpp|h|hpp|cs|vue|svelte|php|xml))\b/

export function TerminalView({ ptyId, isActive, cwd, onFileClick }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const theme = useSettingsStore((s) => s.theme)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [pendingImage, setPendingImage] = useState<{ path: string; size: number; objectUrl: string } | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: getTermTheme(),
      fontFamily: '"Menlo", "Consolas", "DejaVu Sans Mono", "Courier New", monospace',
      fontSize: useSettingsStore.getState().fontSize,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)

    term.open(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // Defer initial fit to next frame so container has dimensions
    requestAnimationFrame(() => {
      safeFit(containerRef.current, fitAddon)
    })

    // Resize observer
    const container = containerRef.current
    const resizeObserver = new ResizeObserver(() => {
      safeFit(container, fitAddon)
      if (ptyId) {
        window.api.pty.resize(ptyId, term.cols, term.rows)
      }
    })
    resizeObserver.observe(container)

    // Copy: Ctrl+C (Win/Linux) or Cmd+C (Mac) when text is selected
    // Paste: Ctrl+V (Win/Linux) or Cmd+V (Mac)
    // Find: Ctrl+F (Win/Linux) or Cmd+F (Mac)
    term.attachCustomKeyEventHandler((event) => {
      const modifier = navigator.platform.includes('Mac') ? event.metaKey : event.ctrlKey
      if (!modifier) return true

      if (event.type === 'keydown' && event.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection())
        return false
      }

      if (event.type === 'keydown' && event.key === 'v') {
        // Check for image in clipboard first
        navigator.clipboard.read().then(async (items) => {
          const imageItem = items.find(item => item.types.some(t => t.startsWith('image/')))
          if (imageItem) {
            const imageType = imageItem.types.find(t => t.startsWith('image/')) || 'image/png'
            const blob = await imageItem.getType(imageType)
            const buffer = await blob.arrayBuffer()
            const savedPath = await window.api.clipboard.saveImage(buffer)
            const { size } = await window.api.clipboard.getImageSize(savedPath)
            const objectUrl = URL.createObjectURL(blob)
            setPendingImage({ path: savedPath, size, objectUrl })
          } else {
            // No image — paste text
            const text = await navigator.clipboard.readText()
            if (ptyId && text) window.api.pty.write(ptyId, text)
          }
        }).catch(() => {
          // Fallback to text paste if clipboard.read() fails
          navigator.clipboard.readText().then(text => {
            if (ptyId && text) window.api.pty.write(ptyId, text)
          })
        })
        return false
      }

      if (event.type === 'keydown' && event.key === 'f') {
        setShowSearch(true)
        return false
      }

      return true
    })

    // Link providers — file paths + URLs
    const linkDisposable = term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const line = term.buffer.active.getLine(lineNumber - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString()
        const links: Array<{ startIndex: number; length: number; text: string; type: 'file' | 'url' }> = []

        // Match file paths
        const fileRe = /(?:[\w./~-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|sh|md|json|yaml|yml|toml|css|scss|html|sql|c|cpp|h|hpp|cs|vue|svelte|php|xml)\b/g
        let m: RegExpExecArray | null
        while ((m = fileRe.exec(text)) !== null) {
          links.push({ startIndex: m.index, length: m[0].length, text: m[0], type: 'file' })
        }

        // Match URLs (http/https)
        const urlRe = /https?:\/\/[^\s"'<>)\]]+/g
        while ((m = urlRe.exec(text)) !== null) {
          // Avoid overlapping with file links
          const overlaps = links.some(l => m!.index >= l.startIndex && m!.index < l.startIndex + l.length)
          if (!overlaps) {
            links.push({ startIndex: m.index, length: m[0].length, text: m[0], type: 'url' })
          }
        }

        callback(links.map(l => ({
          range: {
            start: { x: l.startIndex + 1, y: lineNumber },
            end: { x: l.startIndex + l.length + 1, y: lineNumber },
          },
          text: l.text,
          activate(_event: MouseEvent, linkText: string) {
            if (l.type === 'url') {
              window.api.browser.open(linkText)
            } else {
              onFileClick?.(linkText)
            }
          }
        })))
      }
    })

    // PTY data → terminal
    const removeDataListener = window.api.pty.onData(({ id, data }) => {
      if (id === ptyId) {
        term.write(data)
      }
    })

    // Terminal input → PTY
    const disposable = term.onData((data) => {
      if (ptyId) {
        window.api.pty.write(ptyId, data)
      }
    })

    return () => {
      disposable.dispose()
      linkDisposable.dispose()
      try { removeDataListener?.() } catch { /* ignore */ }
      resizeObserver.disconnect()
      term.dispose()
    }
  }, [ptyId])

  // React to fontSize changes from settings
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize
      safeFit(containerRef.current, fitAddonRef.current)
    }
  }, [fontSize])

  // React to theme changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTermTheme()
    }
  }, [theme])

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus()
      safeFit(containerRef.current, fitAddonRef.current)
    }
  }, [isActive])

  // Cleanup pending image object URL on unmount
  useEffect(() => {
    return () => {
      if (pendingImage) URL.revokeObjectURL(pendingImage.objectUrl)
    }
  }, [pendingImage])

  // Global Escape to close search
  useEffect(() => {
    if (!showSearch) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSearch(false)
        searchAddonRef.current?.clearDecorations()
        termRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showSearch])

  // Auto-focus search input
  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus()
  }, [showSearch])

  const handleSearch = useCallback((query: string, direction: 'next' | 'prev' = 'next') => {
    if (!searchAddonRef.current || !query) return
    if (direction === 'next') {
      searchAddonRef.current.findNext(query)
    } else {
      searchAddonRef.current.findPrevious(query)
    }
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: isActive ? 'block' : 'none',
        overflow: 'hidden'
      }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Search bar */}
      {showSearch && (
        <div style={{
          position: 'absolute', top: 8, right: 24, zIndex: 10,
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '4px 8px', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); handleSearch(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSearch(searchQuery, e.shiftKey ? 'prev' : 'next')
              }
              if (e.key === 'Escape') {
                setShowSearch(false)
                searchAddonRef.current?.clearDecorations()
                termRef.current?.focus()
              }
            }}
            placeholder="Find..."
            style={{
              width: 180, padding: '4px 8px', fontSize: 12,
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 4, color: 'var(--text-primary)', outline: 'none',
            }}
          />
          <button
            onClick={() => handleSearch(searchQuery, 'prev')}
            title="Previous (Shift+Enter)"
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 14, padding: '2px 4px', lineHeight: 1,
            }}
          >&#x25B2;</button>
          <button
            onClick={() => handleSearch(searchQuery, 'next')}
            title="Next (Enter)"
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 14, padding: '2px 4px', lineHeight: 1,
            }}
          >&#x25BC;</button>
          <button
            onClick={() => { setShowSearch(false); searchAddonRef.current?.clearDecorations(); termRef.current?.focus() }}
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 14, padding: '2px 4px', lineHeight: 1,
            }}
          >&#x2715;</button>
        </div>
      )}

      {/* Image paste confirmation bar */}
      {pendingImage && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
          background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)',
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          animation: 'fadeIn 0.15s ease-out',
        }}>
          <img
            src={pendingImage.objectUrl}
            alt="Clipboard image"
            style={{ width: 80, height: 56, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pendingImage.path.split(/[/\\]/).pop()}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {pendingImage.size > 1024 * 1024
                ? `${(pendingImage.size / 1024 / 1024).toFixed(1)} MB`
                : `${Math.round(pendingImage.size / 1024)} KB`}
              {' · PNG'}
            </div>
          </div>
          <button
            onClick={() => {
              if (ptyId) {
                const escaped = pendingImage.path.includes(' ') ? `"${pendingImage.path}"` : pendingImage.path
                window.api.pty.write(ptyId, escaped)
              }
              URL.revokeObjectURL(pendingImage.objectUrl)
              setPendingImage(null)
              termRef.current?.focus()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.click()
            }}
            autoFocus
            style={{
              padding: '6px 16px', background: 'var(--accent)', color: '#fff',
              border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            Send to Claude ↵
          </button>
          <button
            onClick={() => {
              URL.revokeObjectURL(pendingImage.objectUrl)
              setPendingImage(null)
              termRef.current?.focus()
            }}
            style={{
              padding: '6px 12px', background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: 6, fontSize: 12,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
