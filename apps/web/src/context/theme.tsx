import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

const ThemeContext = createContext<{
	theme: Theme;
	toggleTheme: () => void;
} | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setTheme] = useState<Theme>("dark");

	useEffect(() => {
		const root = window.document.documentElement;
		root.classList.remove("light", "dark");
		root.classList.add(theme);
		root.setAttribute("data-chalk-theme", theme);
	}, [theme]);

	const toggleTheme = () => {
		setTheme((prev) => (prev === "dark" ? "light" : "dark"));
	};

	return (
		<ThemeContext.Provider value={{ theme, toggleTheme }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
