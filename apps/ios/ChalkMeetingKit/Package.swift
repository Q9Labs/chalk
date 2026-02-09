// swift-tools-version: 5.9

import PackageDescription

let package = Package(
	name: "ChalkMeetingKit",
	platforms: [
		.iOS(.v16),
	],
	products: [
		.library(name: "ChalkMeetingKit", targets: ["ChalkMeetingKit"]),
	],
	dependencies: [
		// RealtimeKit (media). Keep as a normal SPM dependency so the app target can resolve it.
		.package(url: "https://github.com/dyte-in/RealtimeKitCoreiOS.git", from: "1.6.1"),
	],
	targets: [
		.target(
			name: "ChalkMeetingKit",
			dependencies: [
				.product(name: "RealtimeKit", package: "RealtimeKitCoreiOS"),
			]
		),
	]
)
