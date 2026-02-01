import { describe, expect, it } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useParticipantVolume } from "../../hooks/ui/useParticipantVolume";

describe("useParticipantVolume", () => {
	it("starts with empty map and getAudioVolume returns 1", () => {
		const { result } = renderHook(() => useParticipantVolume());

		expect(result.current.participantVolumes.size).toBe(0);
		expect(result.current.getAudioVolume("any-id")).toBe(1);
	});

	it("sets volume and updates map + getAudioVolume", () => {
		const { result } = renderHook(() => useParticipantVolume());

		act(() => {
			result.current.setParticipantVolume("p1", 50);
		});

		expect(result.current.participantVolumes.get("p1")).toBe(50);
		expect(result.current.getAudioVolume("p1")).toBe(0.5);
	});

	it("clamps values below 0 to 0", () => {
		const { result } = renderHook(() => useParticipantVolume());

		act(() => {
			result.current.setParticipantVolume("p1", -10);
		});

		expect(result.current.participantVolumes.get("p1")).toBe(0);
		expect(result.current.getAudioVolume("p1")).toBe(0);
	});

	it("treats values >= 100 as default (deletes entry)", () => {
		const { result } = renderHook(() => useParticipantVolume());

		act(() => {
			result.current.setParticipantVolume("p1", 50);
		});
		expect(result.current.participantVolumes.has("p1")).toBe(true);

		act(() => {
			result.current.setParticipantVolume("p1", 100);
		});
		expect(result.current.participantVolumes.has("p1")).toBe(false);
		expect(result.current.getAudioVolume("p1")).toBe(1);
	});

	it("treats values > 100 as default (deletes entry)", () => {
		const { result } = renderHook(() => useParticipantVolume());

		act(() => {
			result.current.setParticipantVolume("p1", 150);
		});
		expect(result.current.participantVolumes.has("p1")).toBe(false);
		expect(result.current.getAudioVolume("p1")).toBe(1);
	});

	it("resets volume by removing entry", () => {
		const { result } = renderHook(() => useParticipantVolume());

		act(() => {
			result.current.setParticipantVolume("p1", 30);
		});
		expect(result.current.participantVolumes.has("p1")).toBe(true);

		act(() => {
			result.current.resetParticipantVolume("p1");
		});
		expect(result.current.participantVolumes.has("p1")).toBe(false);
		expect(result.current.getAudioVolume("p1")).toBe(1);
	});

	it("rounds fractional volumes", () => {
		const { result } = renderHook(() => useParticipantVolume());

		act(() => {
			result.current.setParticipantVolume("p1", 33.7);
		});
		expect(result.current.participantVolumes.get("p1")).toBe(34);
	});

	it("manages multiple participants independently", () => {
		const { result } = renderHook(() => useParticipantVolume());

		act(() => {
			result.current.setParticipantVolume("p1", 25);
			result.current.setParticipantVolume("p2", 75);
		});

		expect(result.current.getAudioVolume("p1")).toBe(0.25);
		expect(result.current.getAudioVolume("p2")).toBe(0.75);
		expect(result.current.getAudioVolume("p3")).toBe(1);
	});
});
