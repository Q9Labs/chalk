/// <reference types="vite/client" />

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
