import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const renderer = resolve(process.env.CHALK_ANNOTATION_RENDERER_ROOT ?? join(packageRoot, "../../../packages/screen-annotation"));
const rendererEntry = join(renderer, "src/index.ts");
const destination = join(packageRoot, "embedded/chalk-annotation");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");
const hasRenderer = await access(rendererEntry).then(
  () => true,
  (error) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  },
);

// Keep the native package buildable on the phase-zero contract before the shared renderer lands.
if (!hasRenderer) {
  await writeFile(join(destination, "index.html"), "<!doctype html><meta charset=utf-8>");
} else {
  const appEntry = join(packageRoot, "scripts/annotation-webview.mjs");
  const { outputFiles } = await build({
    stdin: {
      contents: `import * as engine from ${JSON.stringify(rendererEntry)}; import { mount } from ${JSON.stringify(appEntry)}; mount(engine);`,
      resolveDir: packageRoot,
    },
    format: "iife",
    bundle: true,
    write: false,
    minify: true,
    target: ["safari15", "chrome100"],
  });
  const font = await readFile(join(renderer, "fonts/Figtree-SemiBold.ttf"));
  await writeFile(join(destination, "OFL.txt"), await readFile(join(renderer, "fonts/OFL.txt")));
  await writeFile(
    join(destination, "index.html"),
    `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<style>
@font-face{font-family:"Chalk Annotation Figtree";src:url(data:font/ttf;base64,${font.toString("base64")});font-weight:600}
html,body,canvas{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}canvas{display:block}
</style><canvas></canvas><script>${outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`,
  );
}
