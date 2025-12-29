export function snakeToCamelString(str: string): string {
	return str.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

export function camelToSnakeString(str: string): string {
	return str.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date) &&
		!(value instanceof RegExp) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

export function snakeToCamel<T>(obj: unknown): T {
	if (obj === null || obj === undefined) {
		return obj as T;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => snakeToCamel(item)) as T;
	}

	if (obj instanceof Date) {
		return obj as T;
	}

	if (isPlainObject(obj)) {
		const result: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(obj)) {
			const camelKey = snakeToCamelString(key);
			result[camelKey] = snakeToCamel(value);
		}

		return result as T;
	}

	return obj as T;
}

export function camelToSnake<T>(obj: unknown): T {
	if (obj === null || obj === undefined) {
		return obj as T;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => camelToSnake(item)) as T;
	}

	if (obj instanceof Date) {
		return obj as T;
	}

	if (isPlainObject(obj)) {
		const result: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(obj)) {
			const snakeKey = camelToSnakeString(key);
			result[snakeKey] = camelToSnake(value);
		}

		return result as T;
	}

	return obj as T;
}
