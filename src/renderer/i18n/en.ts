export const en = {
  // App
  'app.title': 'Inkess Claude Code Pro',
  'app.connected': 'Connected',

  // Tab context menu
  'tab.openInFinder': 'Open in Finder',
  'tab.openInExplorer': 'Open in Explorer',
  'tab.openInIde': 'Open in {ide}',
  'tab.copyPath': 'Copy Path',
  'tab.closeTab': 'Close Tab',

  // Setup
  'setup.checking': 'Checking environment...',
  'setup.settingUp': 'Setting up Claude Code CLI',
  'setup.verifying': 'Verifying Claude Code CLI installation',
  'setup.firstTime': 'First-time setup — this only takes a moment',
  'setup.checkEnv': 'Checking environment',
  'setup.downloading': 'Downloading Claude Code CLI...',
  'setup.verifyInstall': 'Verifying installation',
  'setup.downloadComplete': 'Download complete',
  'setup.verifyingInstall': 'Verifying installation...',
  'setup.installComplete': 'Installation complete',
  'setup.retry': 'Retry',
  'setup.checkingTools': 'Checking development tools...',
  'setup.installingTools': 'Installing development tools',
  'setup.downloadingTools': 'Downloading development tools...',
  'setup.toolsDownloadComplete': 'Development tools downloaded',
  'setup.verifyingTools': 'Verifying development tools...',
  'setup.toolsReady': 'Development tools ready',
  'setup.toolsSkipped': 'Development tools (optional, skipped)',

  // Settings
  'settings.title': 'Settings',
  'settings.network': 'Network',
  'settings.appearance': 'Appearance',
  'settings.language': 'Language',
  'settings.terminalFontSize': 'Terminal Font Size',
  'settings.theme': 'Theme',
  'settings.themeAuto': 'Auto (System)',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.languageAuto': 'Auto (System)',
  'settings.languageZh': 'Chinese (中文)',
  'settings.languageEn': 'English',
  'settings.languageLabel': 'Display Language',
  'settings.languageHint': 'Choose the display language for the app',
  'settings.about': 'About',
  'settings.version': 'Version',
  'settings.diagnostics': 'Diagnostics',
  'settings.diagnosticsHint': 'Upload logs to help troubleshoot issues',
  'settings.uploadLogs': 'Upload Logs',
  'settings.uploadingLogs': 'Uploading...',
  'settings.logsUploaded': 'Uploaded',
  'settings.logsUploadFailed': 'Upload Failed',
  'settings.notifications': 'Notifications',
  'settings.notificationsEnabled': 'Desktop notifications',
  'settings.sleepInhibitor': 'Sleep Prevention',
  'settings.sleepInhibitorEnabled': 'Prevent sleep during tasks',

  // Proxy
  'settings.proxyToggle': 'Proxy',
  'settings.proxyEnabled': 'Enable network proxy',
  'settings.proxyMode': 'Proxy Mode',
  'settings.proxyModeDirect': 'Direct URL',
  'settings.proxyModeSub': 'Subscription',
  'settings.proxyUrl': 'Proxy Address',
  'settings.proxyUrlHint': 'Supports http://, https://, socks5://, socks4:// — with optional auth (user:pass@host:port)',
  'settings.proxySubUrl': 'Subscription URL',
  'settings.proxyNodes': 'Nodes',
  'settings.proxyNodesHint': '⚠ nodes require a local proxy client (Clash/V2Ray) to use',
  'settings.proxyRegion': 'Environment Region',
  'settings.proxyRegionHint': 'Match timezone and locale to your proxy location to avoid detection',
  'settings.proxyStatus': 'Effective Environment Variables',
  'settings.proxyApplyHint': 'Applied to new terminal tabs. Existing tabs are not affected.',

  // Welcome
  'welcome.openFolder': 'Open Working Directory',
  'welcome.recentProjects': 'Recent Projects',
  'welcome.noRecent': 'Open a working directory to get started',
  'welcome.letsBuild': "Let's build",
  'welcome.openProject': 'Open a project',
  'welcome.cardRecent': 'Open a recent project',
  'welcome.cardRecentDesc': 'Continue where you left off',
  'welcome.cardNew': 'Open folder',
  'welcome.cardNewDesc': 'Start working on a project',
  'welcome.hintCommands': 'Commands',
  'welcome.hintMode': 'Switch mode',
  'welcome.hintSearch': 'Find in terminal',

  // Sidebar
  'sidebar.recentProjects': 'Recent Projects',
  'sidebar.noProjects': 'No projects yet',
  'sidebar.settings': 'Settings',
  'sidebar.cliStatus': 'Claude Code CLI',
  'sidebar.sessions': 'Sessions',
  'sidebar.active': 'Active',
  'sidebar.recent': 'Recent',
  'sidebar.yesterday': 'yesterday',
  'sidebar.newSession': 'New Session',
  'sidebar.commands': 'Commands',
  'sidebar.projects': 'Projects',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',
  'sidebar.pinned': 'Pinned',

  // StatusBar
  'statusbar.preventingSleep': 'Preventing sleep',

  // Close Tab
  'tab.pressAgainToClose': 'Press again to close',

  // Command Palette
  'cmdPalette.placeholder': 'Type a command, / for Claude commands, ⇧Tab to switch mode',
  'cmdPalette.noResults': 'No matching commands',
  'cmdPalette.newTab': 'New Tab',
  'cmdPalette.settings': 'Settings',
  'cmdPalette.toggleTheme': 'Toggle Theme',
  'cmdPalette.modeSuggest': 'Mode: Suggest',
  'cmdPalette.modeAutoEdit': 'Mode: Auto Edit',
  'cmdPalette.modeFullAuto': 'Mode: Full Auto',

  // File Preview
  'preview.notFound': 'File not found or too large to preview',
  'preview.copyPath': 'Copy Path',

  // Session History
  'history.title': 'Session History',
  'history.back': 'Back',
  'history.search': 'Search history...',
  'history.empty': 'No session history yet',
  'history.noResults': 'No matching sessions',
  'history.selectSession': 'Select a session to view',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',
  'history.openInTerminal': 'Open in Terminal',
  'history.copyAll': 'Copy All',

  // Drag & Drop
  'drag.dropToOpen': 'Drop to open',
  'drag.hint': 'Drop a folder to open as project, or a file to insert its path',

  // Update
  'update.available': 'Update Available',
  'update.description': 'Claude Code CLI {latest} is available (current: {current})',
  'update.now': 'Update Now',
  'update.updating': 'Updating...',
  'update.later': 'Later',

  // App Update
  'appUpdate.ready': 'v{version} ready to install',
  'appUpdate.available': 'App update v{version} available',
  'appUpdate.restartUpdate': 'Restart & Update',
  'appUpdate.download': 'Download',
}

export type TranslationKey = keyof typeof en
