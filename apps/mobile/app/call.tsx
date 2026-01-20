import { StyleSheet, Text, View } from "react-native";

export default function CallScreen() {
	return (
		<View style={styles.container}>
			<Text style={styles.text}>Call Screen</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "#111",
	},
	text: {
		color: "#fff",
		fontSize: 18,
	},
});
