import type React from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import {
	usePictureInPicture,
	type UsePictureInPictureOptions,
} from "../../../hooks/ui/usePictureInPicture";
import type { PictureInPictureControls } from "./types";

interface SharedPictureInPictureRegistration {
	ownerId: string;
	options: UsePictureInPictureOptions;
}

interface SharedPictureInPictureValue {
	isSupported: boolean;
	isActive: boolean;
	phase: UsePictureInPictureOptions["phase"];
	open: () => Promise<void>;
	close: () => Promise<void>;
	toggle: () => Promise<void>;
	register: (
		ownerId: string,
		options: UsePictureInPictureOptions | null,
	) => void;
}

const EMPTY_CONTROLS: PictureInPictureControls = {};

const SharedPictureInPictureContext =
	createContext<SharedPictureInPictureValue | null>(null);

export function SharedPictureInPictureProvider({
	enabled = true,
	children,
}: {
	enabled?: boolean;
	children: React.ReactNode;
}) {
	const [registration, setRegistration] =
		useState<SharedPictureInPictureRegistration | null>(null);

	const register = useCallback(
		(ownerId: string, options: UsePictureInPictureOptions | null) => {
			setRegistration((current) => {
				if (!options) {
					return current?.ownerId === ownerId ? null : current;
				}

				return {
					ownerId,
					options,
				};
			});
		},
		[],
	);

	const pictureInPicture = usePictureInPicture({
		enabled: enabled && Boolean(registration),
		phase: registration?.options.phase ?? "meeting",
		roomName: registration?.options.roomName,
		displayName: registration?.options.displayName,
		source: registration?.options.source ?? null,
		previewSource: registration?.options.previewSource,
		controls: registration?.options.controls ?? EMPTY_CONTROLS,
	});

	const value = useMemo<SharedPictureInPictureValue>(
		() => ({
			...pictureInPicture,
			register,
		}),
		[pictureInPicture, register],
	);

	return (
		<SharedPictureInPictureContext.Provider value={value}>
			{children}
		</SharedPictureInPictureContext.Provider>
	);
}

export function useSharedPictureInPicture() {
	return useContext(SharedPictureInPictureContext);
}
