export async function routeCallFixtureAssets(page, boardCss) {
  await page.route("**/chalk-whiteboard/0.18.1/index.css", (route) => route.fulfill({ path: boardCss, contentType: "text/css" }));
  await page.route(/\/fonts\/(site|sign-in)\.css$/, (route) => route.fulfill({ body: "", contentType: "text/css" }));
}
