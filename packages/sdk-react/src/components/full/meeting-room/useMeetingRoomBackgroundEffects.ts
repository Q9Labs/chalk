import type { VideoBackgroundEffect } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BackgroundEffect } from "../../composite/BackgroundEffectsPicker";
import type { MeetingRoomSettings } from "../../../hooks/useMeetingRoomSettings";
import {
	loadLocalBackgroundAsset,
	persistLocalBackgroundAsset,
} from "../../../utils/localBackgroundAssetStore";
import {
	areVideoBackgroundEffectsEqual,
	getStoredVideoBackgroundEffectId,
	getVideoBackgroundPreset,
	toRuntimeVideoBackgroundEffect,
	VIDEO_BACKGROUND_BLUR_ID,
	VIDEO_BACKGROUND_CUSTOM_ID,
	VIDEO_BACKGROUND_PRESETS,
	type StoredVideoBackgroundEffect,
} from "../../../utils/videoBackgrounds";

interface UseMeetingRoomBackgroundEffectsParams {
	enabled: boolean;
	settings: MeetingRoomSettings;
	updateVideoSettings: (updates: Partial<MeetingRoomSettings["video"]>) => void;
	currentEffect: VideoBackgroundEffect;
	isSupported: boolean;
	isApplying: boolean;
	applyBackgroundEffect?: (effect: VideoBackgroundEffect) => Promise<void> | void;
	clearBackgroundEffect?: () => Promise<void> | void;
}

const applyAsync = async (
	task?: (() => Promise<void> | void) | undefined,
) => {
	if (!task) {
		return;
	}

	await task();
};

export const useMeetingRoomBackgroundEffects = ({
	enabled,
	settings,
	updateVideoSettings,
	currentEffect,
	isSupported,
	isApplying,
	applyBackgroundEffect,
	clearBackgroundEffect,
}: UseMeetingRoomBackgroundEffectsParams) => {
	const backgroundEffect = settings.video.backgroundEffect;
	const [customPreviewUrl, setCustomPreviewUrl] = useState<string | null>(null);
	const customPreviewUrlRef = useRef<string | null>(null);
	customPreviewUrlRef.current = customPreviewUrl;

	useEffect(() => {
		if (
			!backgroundEffect ||
			backgroundEffect.type !== "custom" ||
			!backgroundEffect.assetKey
		) {
			setCustomPreviewUrl((previous) => {
				if (previous) {
					URL.revokeObjectURL(previous);
				}
				return null;
			});
			return;
		}

		let cancelled = false;

		void loadLocalBackgroundAsset(backgroundEffect.assetKey)
			.then((asset) => {
				if (cancelled) {
					return;
				}

				if (!asset) {
					updateVideoSettings({
						backgroundEffect: { type: "none" },
					});
					return;
				}

				const nextUrl = URL.createObjectURL(asset);
				setCustomPreviewUrl((previous) => {
					if (previous) {
						URL.revokeObjectURL(previous);
					}
					return nextUrl;
				});
			})
			.catch(() => {
				if (!cancelled) {
					updateVideoSettings({
						backgroundEffect: { type: "none" },
					});
				}
			});

		return () => {
			cancelled = true;
		};
	}, [backgroundEffect, updateVideoSettings]);

	useEffect(() => {
		return () => {
			if (customPreviewUrlRef.current) {
				URL.revokeObjectURL(customPreviewUrlRef.current);
			}
		};
	}, []);

	const effects = useMemo<BackgroundEffect[]>(() => {
		const nextEffects: BackgroundEffect[] = [
			{
				id: VIDEO_BACKGROUND_BLUR_ID,
				type: "blur",
				name: "Blur",
			},
			...VIDEO_BACKGROUND_PRESETS.map((preset) => ({
				id: preset.id,
				type: "image" as const,
				name: preset.name,
				thumbnail: preset.imageUrl,
				value: preset.imageUrl,
			})),
		];

		if (
			backgroundEffect?.type === "custom" &&
			customPreviewUrl
		) {
			nextEffects.push({
				id: VIDEO_BACKGROUND_CUSTOM_ID,
				type: "image",
				name: backgroundEffect.fileName || "Custom",
				thumbnail: customPreviewUrl,
				value: customPreviewUrl,
			});
		}

		return nextEffects;
	}, [backgroundEffect, customPreviewUrl]);

	const selectedEffectId = useMemo(
		() => getStoredVideoBackgroundEffectId(backgroundEffect),
		[backgroundEffect],
	);

	const syncRuntimeEffect = useCallback(
		async (nextEffect: StoredVideoBackgroundEffect, customImageUrl?: string | null) => {
			if (!enabled || !isSupported) {
				return;
			}

			const runtimeEffect = toRuntimeVideoBackgroundEffect(nextEffect, customImageUrl);

			if (runtimeEffect.mode === "none") {
				if (currentEffect.mode !== "none") {
					await applyAsync(clearBackgroundEffect);
				}
				return;
			}

			if (areVideoBackgroundEffectsEqual(currentEffect, runtimeEffect)) {
				return;
			}

			await applyAsync(() => applyBackgroundEffect?.(runtimeEffect));
		},
		[
			applyBackgroundEffect,
			clearBackgroundEffect,
			currentEffect,
			enabled,
			isSupported,
		],
	);

	useEffect(() => {
		if (!enabled || !backgroundEffect) {
			return;
		}

		if (backgroundEffect.type === "custom" && !customPreviewUrl) {
			return;
		}

		void syncRuntimeEffect(backgroundEffect, customPreviewUrl);
	}, [
		backgroundEffect,
		customPreviewUrl,
		enabled,
		syncRuntimeEffect,
	]);

	const handleSelect = useCallback(
		(effectId: string) => {
			if (effectId === "none") {
				updateVideoSettings({
					backgroundEffect: { type: "none" },
				});
				void syncRuntimeEffect({ type: "none" });
				return;
			}

			if (effectId === VIDEO_BACKGROUND_BLUR_ID) {
				const nextEffect: StoredVideoBackgroundEffect = { type: "blur" };
				updateVideoSettings({ backgroundEffect: nextEffect });
				void syncRuntimeEffect(nextEffect);
				return;
			}

			if (effectId === VIDEO_BACKGROUND_CUSTOM_ID && backgroundEffect?.type === "custom") {
				void syncRuntimeEffect(backgroundEffect, customPreviewUrl);
				return;
			}

			const preset = getVideoBackgroundPreset(effectId);
			if (!preset) {
				return;
			}

			const nextEffect: StoredVideoBackgroundEffect = {
				type: "preset",
				presetId: preset.id,
			};
			updateVideoSettings({ backgroundEffect: nextEffect });
			void syncRuntimeEffect(nextEffect);
		},
		[
			backgroundEffect,
			customPreviewUrl,
			syncRuntimeEffect,
			updateVideoSettings,
		],
	);

	const handleCustomUpload = useCallback(
		(file: File) => {
			void (async () => {
				const assetKey = await persistLocalBackgroundAsset(file);
				const nextPreviewUrl = URL.createObjectURL(file);

				setCustomPreviewUrl((previous) => {
					if (previous) {
						URL.revokeObjectURL(previous);
					}
					return nextPreviewUrl;
				});

				const nextEffect: StoredVideoBackgroundEffect = {
					type: "custom",
					assetKey,
					fileName: file.name,
				};

				updateVideoSettings({ backgroundEffect: nextEffect });
				await syncRuntimeEffect(nextEffect, nextPreviewUrl);
			})();
		},
		[syncRuntimeEffect, updateVideoSettings],
	);

	return {
		effects,
		isApplying,
		isSupported,
		selectedEffectId,
		showControls: enabled,
		handleCustomUpload,
		handleSelect,
	};
};
