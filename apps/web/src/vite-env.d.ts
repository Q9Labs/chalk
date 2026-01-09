/// <reference types="vite/client" />

// MDX imports
declare module "*.mdx" {
	import type { ComponentType } from "react";
	const MDXComponent: ComponentType;
	export default MDXComponent;
}

// Vite CSS URL imports
declare module "*.css?url" {
	const url: string;
	export default url;
}

// Excalidraw CSS specifically
declare module "@excalidraw/excalidraw/dist/prod/index.css?url" {
	const url: string;
	export default url;
}
