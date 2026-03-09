const DB_NAME = "chalk-video-backgrounds";
const STORE_NAME = "images";
const DB_VERSION = 1;

const memoryStore = new Map<string, Blob>();

const supportsIndexedDb = () =>
	typeof window !== "undefined" && typeof indexedDB !== "undefined";

const createAssetKey = () => {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}

	return `background-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const openDatabase = (): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		if (!supportsIndexedDb()) {
			reject(new Error("IndexedDB unavailable"));
			return;
		}

		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Failed to open IndexedDB"));
	});

export const persistLocalBackgroundAsset = async (file: Blob) => {
	const assetKey = createAssetKey();

	if (!supportsIndexedDb()) {
		memoryStore.set(assetKey, file);
		return assetKey;
	}

	const db = await openDatabase();

	await new Promise<void>((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, "readwrite");
		const store = transaction.objectStore(STORE_NAME);
		const request = store.put(file, assetKey);

		request.onsuccess = () => resolve();
		request.onerror = () =>
			reject(request.error ?? new Error("Failed to persist background asset"));
	});

	db.close();
	return assetKey;
};

export const loadLocalBackgroundAsset = async (assetKey: string) => {
	if (!supportsIndexedDb()) {
		return memoryStore.get(assetKey) ?? null;
	}

	const db = await openDatabase();

	const result = await new Promise<Blob | null>((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, "readonly");
		const store = transaction.objectStore(STORE_NAME);
		const request = store.get(assetKey);

		request.onsuccess = () => {
			const value = request.result;
			resolve(value instanceof Blob ? value : null);
		};
		request.onerror = () =>
			reject(request.error ?? new Error("Failed to load background asset"));
	});

	db.close();
	return result;
};
