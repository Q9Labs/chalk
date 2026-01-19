import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@q9labs/chalk-ui/dist/**/*.js",
    "./node_modules/@q9labs/chalk-react/dist/**/*.js",
  ],
  safelist: [
    { pattern: /^chalk-/ },
    { pattern: /^bg-chalk-/ },
    { pattern: /^text-chalk-/ },
    { pattern: /^border-chalk-/ },
    { pattern: /^hover:bg-chalk-/ },
    { pattern: /^hover:border-chalk-/ },
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
    },
  },
  plugins: [],
};
export default config;
