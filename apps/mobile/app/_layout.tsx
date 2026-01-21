import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";

import { useColorScheme } from "@/components/useColorScheme";
import { createTokenProvider } from "@/lib/token-provider";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
	initialRouteName: "index",
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
	const [loaded, error] = useFonts({
		SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
		...FontAwesome.font,
	});

	useEffect(() => {
		if (error) throw error;
	}, [error]);

	useEffect(() => {
		if (loaded) {
			SplashScreen.hideAsync();
		}
	}, [loaded]);

	if (!loaded) {
		return null;
	}

	return <RootLayoutNav />;
}

function RootLayoutNav() {
	const colorScheme = useColorScheme();
	const [sdkError, setSdkError] = useState<string | null>(null);
	const [ChalkProviderComponent, setChalkProviderComponent] =
		useState<React.ComponentType<any> | null>(null);

	// Lazy load ChalkProvider to catch any import errors
	useEffect(() => {
		try {
			const { ChalkProvider } = require("@q9labs/chalk-react-native");
			setChalkProviderComponent(() => ChalkProvider);
		} catch (err) {
			setSdkError(err instanceof Error ? err.message : "Failed to load SDK");
			console.error("Failed to load ChalkProvider:", err);
		}
	}, []);

	// Dynamically import env to avoid any static import issues
	const env = require("@/lib/env").env;

	// Token provider: handles API key → JWT exchange and auto-refresh
	const tokenProvider = useMemo(
		() =>
			env.apiKey
				? createTokenProvider({
						apiKey: env.apiKey,
						apiUrl: env.apiUrl,
					})
				: undefined,
		[env.apiKey, env.apiUrl],
	);

	// Show error if SDK failed to load
	if (sdkError) {
		return (
			<View
				style={{
					flex: 1,
					justifyContent: "center",
					alignItems: "center",
					backgroundColor: "#111",
				}}
			>
				<Text style={{ color: "#f00", fontSize: 16 }}>
					SDK Error: {sdkError}
				</Text>
			</View>
		);
	}

	// Show loading while SDK loads
	if (!ChalkProviderComponent) {
		return (
			<View
				style={{
					flex: 1,
					justifyContent: "center",
					alignItems: "center",
					backgroundColor: "#111",
				}}
			>
				<Text style={{ color: "#fff", fontSize: 16 }}>Loading...</Text>
			</View>
		);
	}

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<ChalkProviderComponent
				tokenProvider={tokenProvider}
				apiUrl={env.apiUrl}
				wsUrl={env.wsUrl}
			>
				<ThemeProvider
					value={colorScheme === "dark" ? DarkTheme : DefaultTheme}
				>
					<Stack>
						<Stack.Screen name="index" options={{ title: "Chalk" }} />
						<Stack.Screen name="call" options={{ headerShown: false }} />
						<Stack.Screen name="settings" options={{ title: "Settings" }} />
					</Stack>
				</ThemeProvider>
			</ChalkProviderComponent>
		</GestureHandlerRootView>
	);
}
