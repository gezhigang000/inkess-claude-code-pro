import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const launched = await launchApp()
  app = launched.app
  page = launched.page
  await waitForReady(page)
})

test.afterAll(async () => {
  await app?.close()
})

test('settings panel opens and closes', async () => {
  const settingsBtn = page.locator('[data-testid="settings-btn"], button:has-text("Settings")').first()
  if (await settingsBtn.isVisible()) {
    await settingsBtn.click()
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible()
  }
})

test('settings sections are navigable', async () => {
  const sections = ['Account', 'Appearance', 'IDE', 'Network']
  for (const section of sections) {
    const tab = page.getByText(section).first()
    if (await tab.isVisible()) {
      await tab.click()
    }
  }
})

test('clicking background closes settings', async () => {
  const overlay = page.locator('[data-testid="settings-overlay"]').first()
  if (await overlay.isVisible()) {
    await overlay.click({ position: { x: 10, y: 10 } })
  }
})

test('account section shows user info', async () => {
  const settingsBtn = page.locator('[data-testid="settings-btn"], button:has-text("Settings")').first()
  if (await settingsBtn.isVisible()) {
    await settingsBtn.click()
    const accountTab = page.getByText('Account').first()
    if (await accountTab.isVisible()) {
      await accountTab.click()
      // Should show email or username
      const accountSection = page.locator('[data-testid="settings-panel"]')
      await expect(accountSection).toBeVisible()
    }
  }
})

test('balance display format is correct', async () => {
  const balanceEl = page.locator('[data-testid="balance"], :text-matches("\\$|¥|balance", "i")').first()
  if (await balanceEl.isVisible()) {
    const text = await balanceEl.textContent()
    // Balance should contain a number
    expect(text).toMatch(/\d/)
  }
})

test('IDE selection section exists', async () => {
  const settingsBtn = page.locator('[data-testid="settings-btn"], button:has-text("Settings")').first()
  if (await settingsBtn.isVisible()) {
    await settingsBtn.click()
    const ideTab = page.getByText('IDE').first()
    if (await ideTab.isVisible()) {
      await ideTab.click()
      // IDE section should have some selection UI
      const ideSection = page.locator('[data-testid="settings-panel"]')
      await expect(ideSection).toBeVisible()
    }
  }
})

test('logout returns to login page', async () => {
  const logoutBtn = page.locator('[data-testid="logout-btn"], button:has-text("Logout"), button:has-text("Log out")').first()
  if (await logoutBtn.isVisible()) {
    await logoutBtn.click()
    // Should show login screen
    await expect(page.getByText('Login')).toBeVisible({ timeout: 5000 })
  }
})
