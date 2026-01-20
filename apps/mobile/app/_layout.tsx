import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect } from "react";
import "react-native-reanimated";

import { ChalkProvider } from "@q9labs/chalk-react-native";
import { useColorScheme } from "@/components/useColorScheme";
import { env } from "@/lib/env";
import { storage } from "@/lib/storage";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
	initialRouteName: "(tabs)",
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

	const tokenProvider = useCallback(async () => {
		const token = await storage.getToken();
		return token ?? "";
	}, []);

	return (
		<ChalkProvider
			apiKey={env.apiKey}
			tokenProvider={tokenProvider}
			apiUrl={env.apiUrl}
			wsUrl={env.wsUrl}
			debug={env.debug}
		>
			<ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
				<Stack>
					<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
					<Stack.Screen
						name="hooks/[hook]"
						options={{ headerBackTitle: "Back" }}
					/>
					<Stack.Screen
						name="components/[component]"
						options={{ headerBackTitle: "Back" }}
					/>
					<Stack.Screen
						name="e2e/[flow]"
						options={{ headerBackTitle: "Back" }}
					/>
				</Stack>
			</ThemeProvider>
		</ChalkProvider>
	);
}
