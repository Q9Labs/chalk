/** @type {import('next').NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	// Required for CSS imports from node_modules packages
	transpilePackages: [
		"@q9labs/chalk-react",
		"@q9labs/chalk-core",
		"@q9labs/chalk-whiteboard",
	],
};

export default nextConfig;
