import { View, Text, StyleSheet } from "react-native";

export default function Index() {
	return (
		<View style={styles.container}>
			<Text style={styles.text}>Chalk Mobile</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		backgroundColor: "#111",
	},
	text: {
		color: "#fff",
		fontSize: 24,
		fontWeight: "bold",
	},
});
