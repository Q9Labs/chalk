/**
 * Tests for React components
 * @module @q9labs/chalk-react/__tests__/components
 */

import { describe, expect, it } from "bun:test";
import type { Participant } from "@q9labs/chalk-core";
import type { VideoTileProps } from "../components/VideoTile.tsx";

describe("Component props and types", () => {
	describe("VideoTile component", () => {
		it("should accept required participant prop", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const props: VideoTileProps = {
				participant,
			};

			expect(props.participant.id).toBe("p1");
			expect(props.participant.displayName).toBe("Alice");
		});

		it("should accept className prop", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const props: VideoTileProps = {
				participant,
				className: "custom-class",
			};

			expect(props.className).toBe("custom-class");
		});

		it("should accept style prop", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const style = { width: "300px", height: "300px" };

			const props: VideoTileProps = {
				participant,
				style,
			};

			expect(props.style).toEqual(style);
		});

		it("should accept mirror prop", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: true,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const props: VideoTileProps = {
				participant,
				mirror: true,
			};

			expect(props.mirror).toBe(true);
		});

		it("should accept overlay props", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const props: VideoTileProps = {
				participant,
				showName: true,
				showStatus: true,
			};

			expect(props.showName).toBe(true);
			expect(props.showStatus).toBe(true);
		});

		it("should accept custom render props", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const renderName = (p: Participant) => `${p.displayName} (${p.role})`;
			const renderStatus = (p: Participant) => (p.videoEnabled ? "📹" : "📵");

			const props: VideoTileProps = {
				participant,
				renderName,
				renderStatus,
			};

			expect(typeof props.renderName).toBe("function");
			expect(typeof props.renderStatus).toBe("function");
			expect(props.renderName(participant)).toBe("Alice (participant)");
			expect(props.renderStatus(participant)).toBe("📹");
		});

		it("should accept onVideoReady callback", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			let videoElementReceived: HTMLVideoElement | null = null;

			const onVideoReady = (video: HTMLVideoElement) => {
				videoElementReceived = video;
			};

			const props: VideoTileProps = {
				participant,
				onVideoReady,
			};

			expect(typeof props.onVideoReady).toBe("function");
		});

		it("should support all prop combinations", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "host",
				isLocal: true,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: true,
				isScreenSharing: true,
				handRaised: false,
				connectionQuality: 95,
			};

			const props: VideoTileProps = {
				participant,
				className: "featured-tile",
				style: { border: "2px solid blue" },
				mirror: true,
				showName: true,
				showStatus: true,
				renderName: (p) => p.displayName,
				renderStatus: (p) => (p.isSpeaking ? "🔊" : "🔇"),
				onVideoReady: () => {},
			};

			expect(props.participant.isLocal).toBe(true);
			expect(props.mirror).toBe(true);
			expect(props.showName).toBe(true);
			expect(props.showStatus).toBe(true);
		});

		it("should handle participants with different states", () => {
			const scenarios = [
				{
					displayName: "Camera Off",
					videoEnabled: false,
					audioEnabled: true,
				},
				{
					displayName: "Muted",
					videoEnabled: true,
					audioEnabled: false,
				},
				{
					displayName: "Screen Sharing",
					videoEnabled: true,
					isScreenSharing: true,
				},
				{
					displayName: "Hand Raised",
					handRaised: true,
				},
				{
					displayName: "Speaking",
					isSpeaking: true,
				},
			];

			scenarios.forEach((scenario) => {
				const participant: Participant = {
					id: "p1",
					displayName: scenario.displayName,
					role: "participant",
					isLocal: false,
					videoEnabled: scenario.videoEnabled ?? true,
					audioEnabled: scenario.audioEnabled ?? true,
					isSpeaking: scenario.isSpeaking ?? false,
					isScreenSharing: scenario.isScreenSharing ?? false,
					handRaised: scenario.handRaised ?? false,
					connectionQuality: 100,
				};

				const props: VideoTileProps = { participant };
				expect(props.participant.displayName).toBe(scenario.displayName);
			});
		});

		it("should support rendering different roles", () => {
			const roles = ["host" as const, "participant" as const];

			roles.forEach((role) => {
				const participant: Participant = {
					id: "p1",
					displayName: "User",
					role,
					isLocal: false,
					videoEnabled: true,
					audioEnabled: true,
					isSpeaking: false,
					isScreenSharing: false,
					handRaised: false,
					connectionQuality: 100,
				};

				const props: VideoTileProps = { participant };
				expect(props.participant.role).toBe(role);
			});
		});

		it("should support local and remote participants", () => {
			const localParticipant: Participant = {
				id: "local",
				displayName: "Me",
				role: "participant",
				isLocal: true,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const remoteParticipant: Participant = {
				id: "remote",
				displayName: "Other",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const localProps: VideoTileProps = {
				participant: localParticipant,
				mirror: true,
			};

			const remoteProps: VideoTileProps = {
				participant: remoteParticipant,
				mirror: false,
			};

			expect(localProps.participant.isLocal).toBe(true);
			expect(remoteProps.participant.isLocal).toBe(false);
		});
	});

	describe("component composition patterns", () => {
		it("should support composing multiple VideoTiles", () => {
			const participants: Participant[] = [
				{
					id: "p1",
					displayName: "Alice",
					role: "host",
					isLocal: true,
					videoEnabled: true,
					audioEnabled: true,
					isSpeaking: true,
					isScreenSharing: false,
					handRaised: false,
					connectionQuality: 100,
				},
				{
					id: "p2",
					displayName: "Bob",
					role: "participant",
					isLocal: false,
					videoEnabled: true,
					audioEnabled: false,
					isSpeaking: false,
					isScreenSharing: false,
					handRaised: true,
					connectionQuality: 85,
				},
				{
					id: "p3",
					displayName: "Charlie",
					role: "participant",
					isLocal: false,
					videoEnabled: false,
					audioEnabled: true,
					isSpeaking: false,
					isScreenSharing: false,
					handRaised: false,
					connectionQuality: 90,
				},
			];

			const tiles: VideoTileProps[] = participants.map((participant) => ({
				participant,
				showName: true,
				showStatus: true,
				mirror: participant.isLocal,
			}));

			expect(tiles.length).toBe(3);
			expect(tiles[0].mirror).toBe(true); // Local participant
			expect(tiles[1].mirror).toBe(false); // Remote participants
			expect(tiles[2].mirror).toBe(false);
		});

		it("should support grid layout props", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const gridProps: VideoTileProps = {
				participant,
				style: {
					gridColumn: "span 1",
					gridRow: "span 1",
				},
			};

			expect(gridProps.style?.gridColumn).toBe("span 1");
		});
	});

	describe("accessibility features", () => {
		it("should support data attributes for testing", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const props: VideoTileProps = {
				participant,
			};

			// Component should render with data-participant-id and data-is-local
			expect(props.participant.id).toBeDefined();
			expect(typeof props.participant.isLocal).toBe("boolean");
		});

		it("should support ARIA labels via custom renders", () => {
			const participant: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const renderName = (p: Participant) =>
				`${p.displayName}${p.videoEnabled ? " camera on" : " camera off"}`;

			const props: VideoTileProps = {
				participant,
				renderName,
			};

			const ariaLabel = props.renderName?.(participant);
			expect(ariaLabel).toContain("camera on");
		});
	});
});
