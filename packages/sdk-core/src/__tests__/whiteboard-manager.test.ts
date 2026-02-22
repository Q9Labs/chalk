import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { WhiteboardManager } from "../managers/whiteboard-manager";

class MockRoom extends EventEmitter {
	public localParticipant = { id: "local" };
	public openCalls = 0;
	public closeCalls = 0;
	public syncCalls = 0;

	canDrawWhiteboard(): boolean {
		return true;
	}

	openWhiteboard(): void {
		this.openCalls += 1;
	}

	closeWhiteboard(): void {
		this.closeCalls += 1;
	}

	requestWhiteboardSync(): void {
		this.syncCalls += 1;
	}
}

describe("WhiteboardManager", () => {
	it("syncs remote open/close events without rebroadcasting", () => {
		const room = new MockRoom();
		const manager = new WhiteboardManager();
		manager.attachRoom(room as any);

		expect(manager.getState().isOpen).toBe(false);

		room.emit("whiteboard-opened", {
			participantId: "remote",
			displayName: "Remote",
		});
		expect(manager.getState().isOpen).toBe(true);
		expect(room.openCalls).toBe(0);

		room.emit("whiteboard-closed", {
			participantId: "remote",
		});
		expect(manager.getState().isOpen).toBe(false);
		expect(room.closeCalls).toBe(0);
	});

	it("still broadcasts on explicit local open/close", () => {
		const room = new MockRoom();
		const manager = new WhiteboardManager();
		manager.attachRoom(room as any);

		manager.open();
		expect(room.openCalls).toBe(1);
		expect(room.syncCalls).toBe(1);
		expect(manager.getState().isOpen).toBe(true);

		manager.close();
		expect(room.closeCalls).toBe(1);
		expect(manager.getState().isOpen).toBe(false);
	});
});
