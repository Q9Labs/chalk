/** @type {import('next').NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	// Required for importing from @q9labs packages
	transpilePackages: [
		"@q9labs/chalk-ui",
		"@q9labs/chalk-react",
		"@q9labs/chalk-core",
		"@q9labs/chalk-whiteboard",
	],
};

export default nextConfig;
