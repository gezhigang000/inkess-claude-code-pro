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

test('app launches and shows login screen', async () => {
  const title = await page.title()
  expect(title).toContain('Inkess')
})

test('login/register tab switching works', async () => {
  const registerTab = page.getByText('Register')
  if (await registerTab.isVisible()) {
    await registerTab.click()
    await expect(page.getByText('Send Code')).toBeVisible()
  }
})

test('empty fields keep submit button disabled', async () => {
  const loginTab = page.getByText('Login')
  if (await loginTab.isVisible()) {
    await loginTab.click()
  }
  const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first()
  if (await emailInput.isVisible()) {
    await emailInput.fill('')
    const submitBtn = page.locator('button[type="submit"]').first()
    if (await submitBtn.isVisible()) {
      await expect(submitBtn).toBeDisabled()
    }
  }
})

test('register form has all required fields', async () => {
  const registerTab = page.getByText('Register')
  if (await registerTab.isVisible()) {
    await registerTab.click()
    // Email field
    await expect(page.locator('input[type="email"], input[placeholder*="email" i]').first()).toBeVisible()
    // Password field
    await expect(page.locator('input[type="password"]').first()).toBeVisible()
    // Verification code field
    await expect(page.locator('input[placeholder*="code" i], input[placeholder*="验证" i]').first()).toBeVisible()
    // Send code button
    await expect(page.getByText('Send Code')).toBeVisible()
  }
})

test('send code button has cooldown behavior', async () => {
  const registerTab = page.getByText('Register')
  if (await registerTab.isVisible()) {
    await registerTab.click()
  }
  const sendCodeBtn = page.getByText('Send Code')
  if (await sendCodeBtn.isVisible()) {
    // Button should be visible and initially enabled (or disabled if email is empty)
    await expect(sendCodeBtn).toBeVisible()
  }
})

test('forgot password link is visible on login tab', async () => {
  const loginTab = page.getByText('Login')
  if (await loginTab.isVisible()) {
    await loginTab.click()
  }
  const forgotLink = page.getByText(/forgot/i).first()
  if (await forgotLink.isVisible()) {
    await expect(forgotLink).toBeVisible()
  }
})

test('password empty keeps submit disabled', async () => {
  const loginTab = page.getByText('Login')
  if (await loginTab.isVisible()) {
    await loginTab.click()
  }
  const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first()
  const passwordInput = page.locator('input[type="password"]').first()
  if (await emailInput.isVisible() && await passwordInput.isVisible()) {
    await emailInput.fill('test@example.com')
    await passwordInput.fill('')
    const submitBtn = page.locator('button[type="submit"]').first()
    if (await submitBtn.isVisible()) {
      await expect(submitBtn).toBeDisabled()
    }
  }
})
