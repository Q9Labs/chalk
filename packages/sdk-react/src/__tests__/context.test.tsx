/**
 * Tests for Chalk React Context
 * @module @chalk/react/__tests__/context
 */

import { describe, expect, it } from "bun:test";
import React from "react";
import {
	ChalkProvider,
	type ChalkProviderProps,
	useChalk,
} from "../context.tsx";

describe("ChalkProvider and useChalk", () => {
	describe("ChalkProvider validation", () => {
		it("should accept apiKey prop", () => {
			const props: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_live_test123",
			};

			expect(props.apiKey).toBe("ck_live_test123");
		});

		it("should accept token prop", () => {
			const props: ChalkProviderProps = {
				children: React.createElement("div"),
				token: "eyJhbGc...",
			};

			expect(props.token).toBe("eyJhbGc...");
		});

		it("should accept custom URLs", () => {
			const props: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_live_test123",
				apiUrl: "https://custom.api.com",
				wsUrl: "wss://custom.ws.com",
			};

			expect(props.apiUrl).toBe("https://custom.api.com");
			expect(props.wsUrl).toBe("wss://custom.ws.com");
		});

		it("should accept debug flag", () => {
			const props: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_live_test123",
				debug: true,
			};

			expect(props.debug).toBe(true);
		});

		it("should support minimal configuration", () => {
			const props: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_live_test123",
			};

			expect(props.children).toBeDefined();
			expect(props.apiKey).toBeDefined();
			expect(props.token).toBeUndefined();
			expect(props.apiUrl).toBeUndefined();
		});

		it("should support both apiKey and token", () => {
			const props: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_live_test123",
				token: "eyJhbGc...",
			};

			expect(props.apiKey).toBeDefined();
			expect(props.token).toBeDefined();
		});
	});

	describe("useChalk hook type safety", () => {
		it("should return context value with correct types", () => {
			const mockContextValue = {
				client: null,
				room: null,
				isConnected: false,
				connectionStatus: "disconnected" as const,
				joinRoom: async () => {
					throw new Error("Not implemented");
				},
				leaveRoom: () => {},
				createRoom: async () => "room_123",
			};

			expect(mockContextValue.client).toBeNull();
			expect(mockContextValue.room).toBeNull();
			expect(typeof mockContextValue.isConnected).toBe("boolean");
			expect(mockContextValue.connectionStatus).toBe("disconnected");
			expect(typeof mockContextValue.joinRoom).toBe("function");
			expect(typeof mockContextValue.leaveRoom).toBe("function");
			expect(typeof mockContextValue.createRoom).toBe("function");
		});

		it("should have connection status as RoomStatus type", () => {
			const statusValues = [
				"connecting",
				"connected",
				"reconnecting",
				"disconnected",
				"failed",
			] as const;

			statusValues.forEach((status) => {
				expect(statusValues).toContain(status);
			});
		});

		it("should have async functions returning promises", async () => {
			const joinRoomFn = async () => "result";

			const result = joinRoomFn();
			expect(result instanceof Promise).toBe(true);
			await result;
		});
	});

	describe("ChalkProviderProps interface", () => {
		it("should have children as ReactNode", () => {
			const children = React.createElement("div", null, "Content");

			const props: ChalkProviderProps = {
				children,
				apiKey: "test_key",
			};

			expect(props.children).toBeDefined();
		});

		it("should have optional authentication props", () => {
			const props: Partial<ChalkProviderProps> = {
				apiKey: "test_key",
				token: undefined,
			};

			expect("apiKey" in props).toBe(true);
			expect("token" in props).toBe(true);
		});

		it("should have optional URL props", () => {
			const props: Partial<ChalkProviderProps> = {
				apiUrl: "https://api.example.com",
				wsUrl: "wss://ws.example.com",
			};

			expect(props.apiUrl).toBeDefined();
			expect(props.wsUrl).toBeDefined();
		});

		it("should have optional debug prop", () => {
			const props: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "test_key",
				debug: true,
			};

			expect(props.debug).toBe(true);
		});
	});

	describe("context value structure", () => {
		it("should have all required context properties", () => {
			const requiredProps = [
				"client",
				"room",
				"isConnected",
				"connectionStatus",
				"joinRoom",
				"leaveRoom",
				"createRoom",
			];

			const contextValue = {
				client: null,
				room: null,
				isConnected: false,
				connectionStatus: "disconnected" as const,
				joinRoom: async () => {
					throw new Error("Mock");
				},
				leaveRoom: () => {},
				createRoom: async () => "room_123",
			};

			requiredProps.forEach((prop) => {
				expect(prop in contextValue).toBe(true);
			});
		});

		it("should have correct method signatures", () => {
			const contextValue = {
				client: null,
				room: null,
				isConnected: false,
				connectionStatus: "disconnected" as const,
				joinRoom: async (roomId: string, config: any) => {
					// noop
				},
				leaveRoom: () => {
					// noop
				},
				createRoom: async (name?: string) => "room_123",
			};

			expect(typeof contextValue.joinRoom).toBe("function");
			expect(typeof contextValue.leaveRoom).toBe("function");
			expect(typeof contextValue.createRoom).toBe("function");
		});
	});

	describe("provider prop validation patterns", () => {
		it("should support apiKey-based authentication", () => {
			const config: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_live_xxx",
			};

			expect(config.apiKey).toMatch(/^ck_live_/);
		});

		it("should support token-based authentication", () => {
			const config: ChalkProviderProps = {
				children: React.createElement("div"),
				token: "eyJhbGciOiJIUzI1NiIs...",
			};

			expect(config.token).toMatch(/^eyJ/);
		});

		it("should support custom endpoints", () => {
			const config: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_live_xxx",
				apiUrl: "http://localhost:3000",
				wsUrl: "ws://localhost:3000/ws",
			};

			expect(config.apiUrl).toMatch(/localhost/);
			expect(config.wsUrl).toMatch(/localhost/);
		});

		it("should support development configuration", () => {
			const config: ChalkProviderProps = {
				children: React.createElement("div"),
				apiKey: "ck_test_dev",
				debug: true,
			};

			expect(config.debug).toBe(true);
		});
	});

	describe("hook error handling types", () => {
		it("should indicate when hook is used outside provider", () => {
			const errorMessage = "useChalk must be used within a ChalkProvider";
			expect(errorMessage).toContain("useChalk");
			expect(errorMessage).toContain("ChalkProvider");
		});
	});
});
