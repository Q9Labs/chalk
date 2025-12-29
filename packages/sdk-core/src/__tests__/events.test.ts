/**
 * Tests for EventEmitter class
 * @module @q9labs/chalk-core/__tests__/events
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "../events.ts";

interface TestEvents {
	"event-1": string;
	"event-2": { id: number; name: string };
	"event-3": null;
}

describe("EventEmitter", () => {
	let emitter: EventEmitter<TestEvents>;

	beforeEach(() => {
		emitter = new EventEmitter<TestEvents>();
	});

	describe("on()", () => {
		it("should register an event handler", () => {
			let called = false;

			emitter.on("event-1", () => {
				called = true;
			});

			emitter.emit("event-1", "test");
			expect(called).toBe(true);
		});

		it("should call handler with correct data", () => {
			let receivedData = "";

			emitter.on("event-1", (data) => {
				receivedData = data;
			});

			emitter.emit("event-1", "hello");
			expect(receivedData).toBe("hello");
		});

		it("should support multiple handlers for same event", () => {
			let count = 0;

			emitter.on("event-1", () => {
				count += 1;
			});
			emitter.on("event-1", () => {
				count += 1;
			});

			emitter.emit("event-1", "test");
			expect(count).toBe(2);
		});

		it("should work with object data", () => {
			let receivedData: { id: number; name: string } | null = null;

			emitter.on("event-2", (data) => {
				receivedData = data;
			});

			emitter.emit("event-2", { id: 42, name: "Alice" });
			expect(receivedData).toEqual({ id: 42, name: "Alice" });
		});

		it("should work with null data", () => {
			let called = false;

			emitter.on("event-3", () => {
				called = true;
			});

			emitter.emit("event-3", null);
			expect(called).toBe(true);
		});

		it("should return unsubscribe function", () => {
			let count = 0;

			const unsubscribe = emitter.on("event-1", () => {
				count += 1;
			});

			emitter.emit("event-1", "test");
			expect(count).toBe(1);

			unsubscribe();

			emitter.emit("event-1", "test");
			expect(count).toBe(1); // Should not increase
		});

		it("should support handler chaining", () => {
			const values: string[] = [];

			emitter.on("event-1", (data) => {
				values.push(data);
			});
			emitter.on("event-1", (data) => {
				values.push(data.toUpperCase());
			});

			emitter.emit("event-1", "test");
			expect(values).toEqual(["test", "TEST"]);
		});
	});

	describe("off()", () => {
		it("should unregister a specific handler", () => {
			let count = 0;

			const handler = () => {
				count += 1;
			};

			emitter.on("event-1", handler);
			emitter.emit("event-1", "test");
			expect(count).toBe(1);

			emitter.off("event-1", handler);
			emitter.emit("event-1", "test");
			expect(count).toBe(1); // Should not increase
		});

		it("should not affect other handlers", () => {
			let count1 = 0;
			let count2 = 0;

			const handler1 = () => {
				count1 += 1;
			};
			const handler2 = () => {
				count2 += 1;
			};

			emitter.on("event-1", handler1);
			emitter.on("event-1", handler2);

			emitter.off("event-1", handler1);

			emitter.emit("event-1", "test");
			expect(count1).toBe(0);
			expect(count2).toBe(1);
		});

		it("should handle removing non-existent handler", () => {
			const handler = () => {
				// noop
			};

			expect(() => {
				emitter.off("event-1", handler);
			}).not.toThrow();
		});

		it("should work with unsubscribe function", () => {
			let count = 0;

			const unsubscribe = emitter.on("event-1", () => {
				count += 1;
			});

			emitter.emit("event-1", "test");
			expect(count).toBe(1);

			unsubscribe();

			emitter.emit("event-1", "test");
			expect(count).toBe(1);
		});
	});

	describe("emit()", () => {
		it("should call all registered handlers", () => {
			let count = 0;

			emitter.on("event-1", () => {
				count += 1;
			});
			emitter.on("event-1", () => {
				count += 1;
			});
			emitter.on("event-1", () => {
				count += 1;
			});

			emitter.emit("event-1", "test");
			expect(count).toBe(3);
		});

		it("should not emit non-registered events", () => {
			let count = 0;

			emitter.on("event-1", () => {
				count += 1;
			});

			// Trying to emit event-2 should not trigger event-1 handlers
			emitter.emit("event-2", { id: 1, name: "test" });
			expect(count).toBe(0);
		});

		it("should handle errors in handlers gracefully", () => {
			let errorCalled = false;

			emitter.on("event-1", () => {
				throw new Error("Handler error");
			});

			emitter.on("event-1", () => {
				errorCalled = true;
			});

			// Should not throw, should continue to next handler
			emitter.emit("event-1", "test");
			expect(errorCalled).toBe(true);
		});

		it("should emit multiple times", () => {
			let count = 0;

			emitter.on("event-1", () => {
				count += 1;
			});

			emitter.emit("event-1", "test1");
			expect(count).toBe(1);

			emitter.emit("event-1", "test2");
			expect(count).toBe(2);

			emitter.emit("event-1", "test3");
			expect(count).toBe(3);
		});
	});

	describe("removeAllListeners()", () => {
		it("should remove all listeners for a specific event", () => {
			let count1 = 0;
			let count2 = 0;

			emitter.on("event-1", () => {
				count1 += 1;
			});
			emitter.on("event-1", () => {
				count1 += 1;
			});
			emitter.on("event-2", () => {
				count2 += 1;
			});

			emitter.removeAllListeners("event-1");

			emitter.emit("event-1", "test");
			expect(count1).toBe(0);

			emitter.emit("event-2", { id: 1, name: "test" });
			expect(count2).toBe(1);
		});

		it("should remove all listeners when no event specified", () => {
			let count1 = 0;
			let count2 = 0;

			emitter.on("event-1", () => {
				count1 += 1;
			});
			emitter.on("event-2", () => {
				count2 += 1;
			});

			emitter.removeAllListeners();

			emitter.emit("event-1", "test");
			expect(count1).toBe(0);

			emitter.emit("event-2", { id: 1, name: "test" });
			expect(count2).toBe(0);
		});

		it("should allow re-registering after removal", () => {
			let count = 0;

			emitter.on("event-1", () => {
				count += 1;
			});

			emitter.removeAllListeners("event-1");

			emitter.on("event-1", () => {
				count += 1;
			});

			emitter.emit("event-1", "test");
			expect(count).toBe(1);
		});
	});

	describe("complex scenarios", () => {
		it("should handle multiple events independently", () => {
			const results: string[] = [];

			emitter.on("event-1", (data) => {
				results.push(`event-1: ${data}`);
			});
			emitter.on("event-2", (data) => {
				results.push(`event-2: ${data.name}`);
			});

			emitter.emit("event-1", "a");
			emitter.emit("event-2", { id: 1, name: "b" });
			emitter.emit("event-1", "c");

			expect(results).toEqual(["event-1: a", "event-2: b", "event-1: c"]);
		});

		it("should handle rapid fire events", () => {
			let count = 0;

			emitter.on("event-1", () => {
				count += 1;
			});

			for (let i = 0; i < 100; i++) {
				emitter.emit("event-1", "test");
			}

			expect(count).toBe(100);
		});

		it("should handle dynamic subscription/unsubscription", () => {
			let count = 0;

			const handler1 = () => {
				count += 1;
			};
			const handler2 = () => {
				count += 1;
			};
			const handler3 = () => {
				count += 1;
			};

			const unsub1 = emitter.on("event-1", handler1);
			const unsub2 = emitter.on("event-1", handler2);
			emitter.on("event-1", handler3);

			emitter.emit("event-1", "test");
			expect(count).toBe(3);

			unsub1();
			emitter.emit("event-1", "test");
			expect(count).toBe(5);

			unsub2();
			emitter.emit("event-1", "test");
			expect(count).toBe(6);
		});
	});
});
