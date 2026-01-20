import { StyleSheet, Text, View } from "react-native";

export default function SettingsScreen() {
	return (
		<View style={styles.container}>
			<Text style={styles.text}>Settings</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "#fff",
	},
	text: {
		color: "#000",
		fontSize: 18,
	},
});
