import { useState, useEffect, useRef } from 'react'
import { codeToHtml } from 'shiki'
import { useSettingsStore, resolveTheme } from '../../stores/settings'
import { useI18n } from '../../i18n'

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', rb: 'ruby', sh: 'bash', bash: 'bash', zsh: 'bash',
  md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', xml: 'xml', html: 'html', css: 'css', scss: 'scss',
  sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  vue: 'vue', svelte: 'svelte', php: 'php',
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

interface FilePreviewProps {
  filePath: string
  cwd: string
  onClose: () => void
}

export function FilePreview({ filePath, cwd, onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [htmlContent, setHtmlContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const theme = useSettingsStore((s) => s.theme)
  const { t } = useI18n()

  // Resolve relative path against cwd (cross-platform safe)
  const isAbsolute = filePath.startsWith('/') || /^[A-Z]:[/\\]/i.test(filePath)
  const sep = window.api.platform === 'win32' ? '\\' : '/'
  const absolutePath = isAbsolute ? filePath : `${cwd}${sep}${filePath}`

  const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const lang = EXT_TO_LANG[ext] || 'text'

  useEffect(() => {
    setLoading(true)
    setError(null)
    setHtmlContent('')

    setImageDataUrl(null)
    setIsBinary(false)

    window.api.fs.readFile(absolutePath, IMAGE_EXTS.has(ext) ? 10 * 1024 * 1024 : undefined).then(async (raw) => {
      if (raw === null) {
        setError(t('preview.notFound'))
        setLoading(false)
        return
      }

      if (raw.startsWith('__IMAGE__:')) {
        setImageDataUrl(raw.slice('__IMAGE__:'.length))
        setLoading(false)
        return
      }

      if (raw === '__BINARY__') {
        setIsBinary(true)
        setLoading(false)
        return
      }

      setContent(raw)

      try {
        const isDark = resolveTheme(useSettingsStore.getState().theme) === 'dark'
        const html = await codeToHtml(raw, {
          lang: lang === 'text' ? 'text' : lang,
          theme: isDark ? 'github-dark' : 'github-light',
        })
        setHtmlContent(html)
      } catch {
        // Fallback: plain text with line numbers
        const lines = raw.split('\n')
        const escaped = lines.map((l, i) =>
          `<span style="color:var(--text-muted);user-select:none;display:inline-block;width:3em;text-align:right;margin-right:1em">${i + 1}</span>${escapeHtml(l)}`
        ).join('\n')
        setHtmlContent(`<pre style="margin:0;font-family:inherit">${escaped}</pre>`)
      }
      setLoading(false)
    })
  }, [absolutePath])

  // Re-highlight when theme changes
  useEffect(() => {
    if (!content) return
    const isDark = resolveTheme(theme) === 'dark'
    codeToHtml(content, {
      lang: lang === 'text' ? 'text' : lang,
      theme: isDark ? 'github-dark' : 'github-light',
    }).then(setHtmlContent).catch(() => {})
  }, [theme, content])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const ideChoice = useSettingsStore((s) => s.ideChoice)
  const ideScheme = ideChoice === 'cursor' ? 'cursor://' : ideChoice === 'zed' ? 'zed://' : 'vscode://'
  const ideName = ideChoice === 'cursor' ? 'Cursor' : ideChoice === 'zed' ? 'Zed' : 'VS Code'

  return (
    <div style={{
      width: '50%', minWidth: 300, maxWidth: 700,
      background: 'var(--bg-primary)', borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      animation: 'slideInRight 0.2s ease-out',
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        background: 'var(--bg-secondary)',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fileName}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{IMAGE_EXTS.has(ext) ? 'image' : ext.toUpperCase() || lang}</span>
        <span
          onClick={onClose}
          onMouseEnter={() => setHovered('close')}
          onMouseLeave={() => setHovered(null)}
          style={{
            width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4, cursor: 'pointer', fontSize: 14,
            color: 'var(--text-muted)',
            background: hovered === 'close' ? 'var(--bg-hover)' : 'transparent',
          }}
        >×</span>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Loading...
        </div>
      ) : error ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--error-text)', fontSize: 13 }}>
          {error}
        </div>
      ) : imageDataUrl ? (
        <div
          ref={contentRef}
          style={{
            flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, background: 'var(--bg-secondary)',
          }}
        >
          <img
            src={imageDataUrl}
            alt={fileName}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 4 }}
          />
        </div>
      ) : isBinary ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span style={{ fontSize: 13 }}>Binary file — cannot preview</span>
          <span style={{ fontSize: 11 }}>Open in external app to view</span>
        </div>
      ) : (
        <div
          ref={contentRef}
          style={{
            flex: 1, overflowY: 'auto', padding: '12px 0',
            fontSize: 13, lineHeight: 1.6,
            fontFamily: '"Menlo", "Consolas", "DejaVu Sans Mono", "Courier New", monospace',
          }}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      )}

      {/* Footer */}
      <div style={{
        padding: '6px 12px', borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        background: 'var(--bg-secondary)',
      }}>
        <button
          onClick={() => {
            const encodedPath = absolutePath.split(/[/\\]/).map(encodeURIComponent).join('/')
            window.api.shell.openExternal(`${ideScheme}file/${encodedPath}`)
          }}
          onMouseEnter={() => setHovered('ide')}
          onMouseLeave={() => setHovered(null)}
          style={{
            padding: '4px 10px', fontSize: 11, borderRadius: 4,
            background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
          }}
        >
          Open in {ideName}
        </button>
        <button
          onClick={() => {
            window.api.clipboard.writeText(absolutePath)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          style={{
            padding: '4px 10px', fontSize: 11, borderRadius: 4,
            background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', cursor: 'pointer',
          }}
        >
          {copied ? 'Copied!' : t('preview.copyPath')}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {absolutePath}
        </span>
      </div>
    </div>
  )
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
