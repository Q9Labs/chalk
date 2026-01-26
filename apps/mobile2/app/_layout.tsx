import { createTokenProvider } from "@q9labs/chalk-core";
import { ChalkProvider } from "@q9labs/chalk-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { useColorScheme } from "@/components/useColorScheme";
import { env } from "@/lib/env";

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

	// Token provider: handles API key -> JWT exchange and auto-refresh
	// Uses AsyncStorage for React Native persistence
	const tokenProvider = useMemo(
		() =>
			env.apiKey
				? createTokenProvider({
						apiKey: env.apiKey,
						apiUrl: env.apiUrl,
						storage: {
							get: (key) => AsyncStorage.getItem(key),
							set: (key, value) => AsyncStorage.setItem(key, value),
							remove: (key) => AsyncStorage.removeItem(key),
						},
					})
				: undefined,
		[],
	);

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<ChalkProvider
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
					</Stack>
				</ThemeProvider>
			</ChalkProvider>
		</GestureHandlerRootView>
	);
}
