import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Waits for entrance animations to settle, then asserts no WCAG 2.2 AA violations. */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  // Framer Motion keeps opacity fades under reduced motion. Scanning mid-fade samples
  // semi-transparent text and reports contrast failures that users never see, which made
  // these tests flaky on slower CI runners. Audit the settled UI instead.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity,
      ),
  );

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  expect(
    results.violations.map((v) => ({
      rule: v.id,
      impact: v.impact,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    })),
  ).toEqual([]);
}
