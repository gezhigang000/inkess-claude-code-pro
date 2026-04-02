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
