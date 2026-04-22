import * as os from 'os'

/**
 * Environment isolation strategy: BUILD FROM SCRATCH (whitelist approach).
 *
 * Instead of inheriting process.env and trying to strip dangerous vars (blacklist),
 * we start with an empty env and only add what's needed. This eliminates the
 * "what did I forget to strip" problem entirely.
 *
 * Categories:
 * 1. Shell essentials — HOME, SHELL, TMPDIR, PATH, TERM
 * 2. Region mask — TZ, LANG, LC_*, USER, LOGNAME (always overridden)
 * 3. Dev tools passthrough — EDITOR, JAVA_HOME, GOPATH, NVM_DIR, etc.
 * 4. Caller injections — CLAUDE_CONFIG_DIR, BROWSER, ZDOTDIR, etc.
 */

/** Region overrides — always applied regardless of user's local settings */
export const DEFAULT_REGION_ENV: Record<string, string> = {
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  USER: 'user',
  LOGNAME: 'user',
}

/** Vars safe to pass through from process.env (dev tools, not identity) */
const PASSTHROUGH_VARS = [
  // Editor / pager
  'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'LESSOPEN', 'LESSCLOSE',
  // Java
  'JAVA_HOME', 'JAVA_OPTS', 'MAVEN_HOME', 'GRADLE_HOME', 'GRADLE_USER_HOME',
  // Go
  'GOPATH', 'GOROOT', 'GOBIN', 'GOPROXY', 'GONOSUMCHECK', 'GOPRIVATE',
  // Rust
  'CARGO_HOME', 'RUSTUP_HOME',
  // Python
  'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV', 'CONDA_PREFIX', 'PYENV_ROOT', 'PIPENV_VENV_IN_PROJECT',
  // Ruby
  'GEM_HOME', 'GEM_PATH', 'RUBY_VERSION', 'RBENV_ROOT',
  // Node
  'NVM_DIR', 'VOLTA_HOME', 'FNM_DIR', 'COREPACK_HOME',
  // Docker / container
  'DOCKER_HOST', 'DOCKER_CONFIG', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME',
  // Build tools
  'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'PKG_CONFIG_PATH',
  'CMAKE_PREFIX_PATH', 'MAKEFLAGS',
  // Homebrew (macOS)
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
  // Git (identity-safe vars only — not GIT_PROXY_COMMAND)
  'GIT_EDITOR', 'GIT_PAGER',
  // Misc dev
  'KUBECONFIG', 'AWS_PROFILE', 'AWS_DEFAULT_REGION',
]

/** Var prefixes safe to pass through (wildcard match) */
const PASSTHROUGH_PREFIXES = [
  'DYLD_',    // macOS dynamic linker (needed for native modules)
  'DENO_',    // Deno
  'BUN_',     // Bun
]

/**
 * Build a clean PTY/chat environment from scratch.
 * @param regionEnv — region-specific overrides (TZ, LANG, etc.)
 * @param extraEnv — caller-injected vars (CLAUDE_CONFIG_DIR, BROWSER, etc.)
 */
export function buildCleanEnv(
  regionEnv: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}

  // 1. Shell essentials (always needed)
  env.HOME = process.env.HOME || os.homedir()
  if (process.platform !== 'win32') {
    env.SHELL = process.env.SHELL || '/bin/zsh'
  }
  if (process.platform === 'win32') {
    // Windows critical env vars — many programs and node-pty depend on these
    const WIN_REQUIRED = [
      'SYSTEMROOT', 'WINDIR', 'COMSPEC',
      'TEMP', 'TMP',
      'USERPROFILE', 'USERNAME', 'USERDOMAIN',
      'APPDATA', 'LOCALAPPDATA',
      'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMMONPROGRAMFILES',
      'HOMEDRIVE', 'HOMEPATH',
      'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
      'SYSTEMDRIVE',
    ]
    for (const key of WIN_REQUIRED) {
      if (process.env[key]) env[key] = process.env[key]!
    }
  } else {
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  // 2. Region mask — overrides identity-revealing locale/timezone
  Object.assign(env, DEFAULT_REGION_ENV, regionEnv)

  // 3. Dev tools passthrough — only safe, non-identity vars
  for (const key of PASSTHROUGH_VARS) {
    const val = process.env[key]
    if (val !== undefined) env[key] = val
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (PASSTHROUGH_PREFIXES.some(p => key.startsWith(p))) {
      env[key] = value
    }
  }

  // 4. Caller injections (CLAUDE_CONFIG_DIR, BROWSER, PATH, etc.)
  // Applied last so they take priority over everything
  Object.assign(env, extraEnv)

  return env
}
