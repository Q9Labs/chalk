import { createRequire } from "node:module";

const { build } = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url))("esbuild");

// The browser bundle every proof guest runs. The Leave proof builds it against the published baseline client too, so it may
// import only what that release exports: `lobby` adds the preconnect helper, which a baseline without the export cannot bundle.
export async function buildSdkBundle(entry, { lobby = false } = {}) {
  const result = await build({
    stdin: {
      contents: `import {createSpaceClient${lobby ? ", preconnect" : ""}} from ${JSON.stringify(entry)};
${lobby ? "window.proofLobby=async(baseUrl,dwellMs)=>{preconnect({baseUrl,keepWarmMs:dwellMs+1000});await new Promise((done)=>setTimeout(done,dwellMs));};\n" : ""}window.proofJoin=async(space,baseUrl,displayName)=>{
 const client=createSpaceClient({space,baseUrl,getAccess:({reason,replaceMediaConnection})=>window.proofAccess({reason,replaceMediaConnection})});
 window.proofClient=client;await client.join({displayName,microphone:true,camera:true});
};`,
      resolveDir: process.cwd(),
      sourcefile: "proof.ts",
    },
    logLevel: "silent",
    nodePaths: [new URL("../../sdks/typescript/client/node_modules", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  return result.outputFiles[0].text;
}
