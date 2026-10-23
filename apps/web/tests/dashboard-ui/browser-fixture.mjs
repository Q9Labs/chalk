export async function browserFixture() {
  const [playwrightPath, origin] = process.argv.slice(2);
  const { chromium } = await import(playwrightPath);
  const browser = await chromium.launch({ ...(process.env.DASHBOARD_BROWSER_PATH ? { executablePath: process.env.DASHBOARD_BROWSER_PATH } : {}), headless: true });
  const fixture = (query) => fetch(`${origin}/__fixture/${query}`).then((response) => response.json());
  return { browser, origin, fixture };
}
