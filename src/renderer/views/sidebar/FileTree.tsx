import { useState, useEffect, useCallback } from 'react'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface FileTreeProps {
  rootPath: string
  onFileClick: (path: string) => void
}

/** Max entries to render per directory — beyond this show a truncation hint. */
const MAX_VISIBLE_ENTRIES = 500

export function FileTree({ rootPath, onFileClick }: FileTreeProps) {
  return (
    <div style={{ paddingLeft: 8 }}>
      <DirChildren parentPath={rootPath} depth={0} onFileClick={onFileClick} />
    </div>
  )
}

function DirChildren({ parentPath, depth, onFileClick }: {
  parentPath: string
  depth: number
  onFileClick: (path: string) => void
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setEntries(null)
    window.api.fs.listDir(parentPath).then((result) => {
      if (!cancelled) {
        setEntries(result)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [parentPath])

  if (loading) {
    return (
      <div style={{ padding: '2px 0 2px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
        ...
      </div>
    )
  }

  if (!entries || entries.length === 0) {
    return (
      <div style={{ padding: '2px 0 2px 8px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Empty
      </div>
    )
  }

  const truncated = entries.length > MAX_VISIBLE_ENTRIES
  const visible = truncated ? entries.slice(0, MAX_VISIBLE_ENTRIES) : entries

  return (
    <>
      {visible.map((entry) => (
        entry.isDirectory ? (
          <DirNode key={entry.path} entry={entry} depth={depth} onFileClick={onFileClick} />
        ) : (
          <FileNode key={entry.path} entry={entry} depth={depth} onFileClick={onFileClick} />
        )
      ))}
      {truncated && (
        <div style={{
          padding: '2px 4px 2px ' + (depth * 12 + 18) + 'px',
          fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic',
        }}>
          ... {entries.length - MAX_VISIBLE_ENTRIES} more items
        </div>
      )}
    </>
  )
}

/** Directories that are typically huge and shouldn't be expanded by default. */
const HEAVY_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', '.output',
  '__pycache__', '.venv', 'venv', '.tox', 'target', 'vendor',
  '.cache', '.parcel-cache', '.turbo', '.svelte-kit',
])

function DirNode({ entry, depth, onFileClick }: {
  entry: FileEntry
  depth: number
  onFileClick: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const isHeavy = HEAVY_DIRS.has(entry.name)

  const toggle = useCallback(() => setExpanded((v) => !v), [])

  if (depth > 8) return null

  return (
    <>
      <div
        onClick={toggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '2px 4px 2px ' + (depth * 12 + 4) + 'px',
          borderRadius: 4, cursor: 'pointer', fontSize: 12,
          color: hovered ? 'var(--text-primary)' : (isHeavy ? 'var(--text-muted)' : 'var(--text-secondary)'),
          background: hovered ? 'var(--bg-hover)' : 'transparent',
          transition: 'background 0.1s',
          userSelect: 'none',
        }}
        title={entry.path}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s', flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke={isHeavy ? 'var(--text-muted)' : 'var(--accent)'} strokeWidth="1.5" style={{ flexShrink: 0 }}>
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.name}
        </span>
      </div>
      {expanded && (
        <DirChildren parentPath={entry.path} depth={depth + 1} onFileClick={onFileClick} />
      )}
    </>
  )
}

function FileNode({ entry, depth, onFileClick }: {
  entry: FileEntry
  depth: number
  onFileClick: (path: string) => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={() => onFileClick(entry.path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '2px 4px 2px ' + (depth * 12 + 18) + 'px',
        borderRadius: 4, cursor: 'pointer', fontSize: 12,
        color: hovered ? 'var(--text-primary)' : 'var(--text-secondary)',
        background: hovered ? 'var(--bg-hover)' : 'transparent',
        transition: 'background 0.1s',
        userSelect: 'none',
      }}
      title={entry.path}
    >
      <FileIcon ext={getExt(entry.name)} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.name}
      </span>
    </div>
  )
}

function getExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

// Static sets — allocated once, not per render
const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'swift', 'kt', 'vue', 'svelte', 'php'])
const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'xml', 'env', 'ini', 'cfg'])
const DOC_EXTS = new Set(['md', 'txt', 'rst', 'doc', 'pdf'])
const STYLE_EXTS = new Set(['css', 'scss', 'less', 'sass'])
const SHELL_EXTS = new Set(['sh', 'bash', 'zsh'])

function FileIcon({ ext }: { ext: string }) {
  let color = 'var(--text-muted)'
  if (CODE_EXTS.has(ext) || ext === 'html') color = '#e06c75'
  else if (CONFIG_EXTS.has(ext)) color = '#e5c07b'
  else if (DOC_EXTS.has(ext)) color = '#61afef'
  else if (STYLE_EXTS.has(ext)) color = '#c678dd'
  else if (SHELL_EXTS.has(ext)) color = '#98c379'

  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}
