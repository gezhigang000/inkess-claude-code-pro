/**
 * Dev tools manifest — defines which tools to bundle per platform.
 *
 * Tools are downloaded at runtime from OSS (same pattern as CLI mirror).
 * The remote manifest.json on OSS is the source of truth for checksums/sizes;
 * this file only defines the tool list and platform mapping.
 */

export const TOOLS_MIRROR_BASE_URL =
  'https://inkess-install-file.oss-cn-beijing.aliyuncs.com/dev-tools'

export type ToolName = 'python' | 'git' | 'node'

export interface ToolDef {
  name: ToolName
  /** Display name for UI */
  displayName: string
  /** Which platforms need this tool (platform-arch keys, e.g. "win32-x64") */
  platforms: string[]
  /** Relative path under the extracted tool dir to the binary */
  binPath: Record<string, string>
  /** Additional bin directories to prepend to PATH (relative to toolsDir) */
  extraPathDirs?: Record<string, string[]>
  /** Extra environment variables to set (relative paths resolved against toolsDir) */
  extraEnv?: Record<string, Record<string, string>>
  /** Command + args to verify the tool works */
  verifyCommand: string[]
}

/**
 * Static tool definitions.
 * Version, URL, checksum, size come from the remote manifest.json on OSS.
 */
export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'python',
    displayName: 'Python',
    platforms: ['win32-x64', 'darwin-arm64', 'darwin-x64'],
    binPath: {
      'win32-x64': 'python/python.exe',
      'darwin-arm64': 'python/bin/python3',
      'darwin-x64': 'python/bin/python3',
    },
    verifyCommand: ['--version'],
  },
  {
    name: 'git',
    displayName: 'Git',
    // macOS has git via Xcode CLT; only bundle for Windows
    platforms: ['win32-x64'],
    binPath: {
      'win32-x64': 'git/cmd/git.exe',
    },
    // Claude Code on Windows requires git-bash; add git/bin (contains bash.exe) to PATH
    // and set CLAUDE_CODE_GIT_BASH_PATH so Claude Code can find bash.exe
    extraPathDirs: {
      'win32-x64': ['git/bin'],
    },
    extraEnv: {
      'win32-x64': { CLAUDE_CODE_GIT_BASH_PATH: 'git/bin/bash.exe' },
    },
    verifyCommand: ['--version'],
  },
  {
    name: 'node',
    displayName: 'Node.js',
    platforms: ['win32-x64', 'darwin-arm64', 'darwin-x64'],
    binPath: {
      'win32-x64': 'node/node.exe',
      'darwin-arm64': 'node/bin/node',
      'darwin-x64': 'node/bin/node',
    },
    verifyCommand: ['--version'],
  },
]

/** Remote manifest.json shape (fetched from OSS) */
export interface RemoteManifest {
  tools: Record<
    ToolName,
    {
      version: string
      platforms: Record<
        string,
        {
          archive: string
          checksum: string
          size: number
        }
      >
    }
  >
}
