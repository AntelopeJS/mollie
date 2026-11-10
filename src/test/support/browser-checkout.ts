import type { Browser, BrowserContext, Page } from "playwright";

import type { MolliePaymentStatus } from "../../mollie/types";
import type { Checkout } from "./payer";

const STEP_TIMEOUT_MS = 30_000;
const MAX_STEPS = 4;
const TEST_CARD = {
  number: "2223 0000 1047 9399",
  verificationCode: "123",
  holder: "Module Test",
};
const CARD_FRAME = 'iframe[src*="/components/card/"]';
const FINAL_STATE = 'input[name="final_state"]';
const SETTLED_ACTIONS = 'input[name="action"]';
const COMPLETED = /\/completed$/;
const MOLLIE_HOST = /(^|\.)mollie\.com$/;

async function leavesMollie(
  context: BrowserContext,
  start: string,
): Promise<boolean> {
  const response = await context.request.get(start, { maxRedirects: 0 });
  const location = response.headers().location;
  return (
    location !== undefined &&
    !MOLLIE_HOST.test(new URL(location, start).hostname)
  );
}

function expiry(now: Date): string {
  return `12/${String((now.getFullYear() + 5) % 100).padStart(2, "0")}`;
}

async function payByCard(page: Page): Promise<void> {
  const card = page.frameLocator(CARD_FRAME);
  await card.locator("#cardNumber").fill(TEST_CARD.number);
  await card.locator("#cardExpiryDate").fill(expiry(new Date()));
  await card.locator("#cardCvv").fill(TEST_CARD.verificationCode);
  await card.locator("#cardHolder").fill(TEST_CARD.holder);
  const left = page.url();
  await card.getByRole("button", { name: "Pay with card" }).click();
  await page.waitForURL((url) => url.href !== left);
}

async function chooseOutcome(
  page: Page,
  outcome: MolliePaymentStatus,
): Promise<void> {
  const left = page.url();
  await page.locator(`${FINAL_STATE}[value="${outcome}"]`).check();
  await page.locator('button[name="submit"]').click();
  await page.waitForURL((url) => url.href !== left);
}

/**
 * Completes Mollie's test-mode checkout in headless Chromium. Mollie asks for
 * a card in a Mollie Components iframe before its test-mode page, and only a
 * browser can fill that form.
 */
export class BrowserCheckout implements Checkout {
  private browser: Promise<Browser> | undefined;

  async complete(start: string, outcome: MolliePaymentStatus): Promise<void> {
    this.browser ??= import("playwright").then(({ chromium }) =>
      chromium.launch(),
    );
    const context = await (await this.browser).newContext();
    context.setDefaultTimeout(STEP_TIMEOUT_MS);
    try {
      if (await leavesMollie(context, start)) return;
      const page = await context.newPage();
      await page.goto(start);
      for (let step = 0; step < MAX_STEPS; step += 1) {
        if (COMPLETED.test(new URL(page.url()).pathname)) return;
        await page
          .locator(`${FINAL_STATE}, ${CARD_FRAME}, ${SETTLED_ACTIONS}`)
          .first()
          .waitFor();
        if ((await page.locator(SETTLED_ACTIONS).count()) > 0) return;
        if ((await page.locator(FINAL_STATE).count()) > 0) {
          await chooseOutcome(page, outcome);
          return;
        }
        await payByCard(page);
      }
      throw new Error(
        `The test-mode checkout at ${start} did not reach a final state`,
      );
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const browser = await this.browser?.catch(() => undefined);
    this.browser = undefined;
    await browser?.close();
  }
}
