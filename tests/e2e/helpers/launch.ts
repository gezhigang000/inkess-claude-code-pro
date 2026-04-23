import { _electron as electron, ElectronApplication, Page } from '@playwright/test'

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
  })
  const page = await app.firstWindow()
  return { app, page }
}

/** Wait for the app to be fully loaded and interactive */
export async function waitForReady(page: Page): Promise<void> {
  // Wait for the main content to render (login screen or main UI)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1000) // Allow renderer to initialize
}

/**
 * Launch app with mock auth state injected via environment variable.
 * The app reads INKESS_MOCK_AUTH in test mode to skip real login.
 */
export async function launchAppAuthenticated(): Promise<{ app: ElectronApplication; page: Page }> {
  const mockAuth = JSON.stringify({
    token: 'test-token-e2e',
    user: { id: 999, email: 'e2e@test.com', username: 'e2e-user', balance: 1000 },
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      INKESS_MOCK_AUTH: mockAuth,
    },
  })
  const page = await app.firstWindow()
  await waitForReady(page)
  return { app, page }
}

/**
 * Launch app in mock mode — subscription/TUN/CLI IPC handlers return
 * mock data so the app reaches terminal/chat UI without real login,
 * network proxy, or Claude CLI binary.
 */
export async function launchAppMocked(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      INKESS_MOCK_MODE: 'true',
    },
  })
  const page = await app.firstWindow()
  await waitForReady(page)
  return { app, page }
}

/**
 * Wait for the terminal UI to be ready (past login → TUN → CLI check).
 * In mock mode this should be near-instant.
 */
export async function waitForTerminalReady(page: Page): Promise<void> {
  // The terminal tab bar has a drag region with specific styling.
  // Wait for any terminal-related element to appear.
  await page.waitForTimeout(2000) // Allow full init cycle
}

/**
 * Wait for chat mode UI to be ready.
 */
export async function waitForChatReady(page: Page): Promise<void> {
  // Chat sidebar has the "+ New chat" button
  await page.getByText('+ New chat').waitFor({ state: 'visible', timeout: 10000 })
}
