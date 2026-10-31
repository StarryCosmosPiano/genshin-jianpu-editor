/** Import regressions intentionally replace their prior fixture. Exercise the
 * real discard button instead of bypassing the document-protection service. */
export async function acceptFixtureImport(page, button) {
  const dirty = await page.evaluate(() => window.__app.hasUnsavedChanges());
  await button.click();
  if (dirty) await page.getByRole("button", { name: "不保存", exact: true }).click();
}
