import React, { useMemo, useRef } from "react";
import { Cancel01Icon, Upload01Icon, Image01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ChalkButton } from "../chalk-ui";

export interface BackgroundEffect {
  id: string;
  type: "none" | "blur" | "image";
  name: string;
  thumbnail?: string;
  value?: string;
}

export interface BackgroundEffectsPickerProps {
  effects: BackgroundEffect[];
  selectedEffectId?: string;
  onSelect: (effectId: string) => void;
  onCustomUpload?: (file: File) => void;
  disabled?: boolean;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

export const BackgroundEffectsPicker = React.memo(({ effects, selectedEffectId, onSelect, onCustomUpload, disabled = false, participantColorSeed, participantGradientPreference, className }: BackgroundEffectsPickerProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onCustomUpload) {
      onCustomUpload(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const isSelected = (id: string) => selectedEffectId === id || (id === "none" && !selectedEffectId && !effects.find((e) => e.id === selectedEffectId));

  return (
    <div className={cn("flex flex-col gap-3", className)} style={themeVariables as React.CSSProperties}>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label="Background effects">
        <ChalkButton
          variant="outline"
          type="button"
          onClick={() => onSelect("none")}
          disabled={disabled}
          className={cn(
            "!relative !min-h-0 !aspect-video !rounded-md !border-2 !p-0 overflow-hidden flex flex-col items-center justify-center transition-all",
            "bg-[var(--chalk-stage)] hover:bg-[var(--chalk-stage)]",
            isSelected("none") ? "border-[var(--chalk-accent)] ring-1 ring-[var(--chalk-focus)] ring-offset-1 ring-offset-[var(--chalk-canvas)]" : "border-transparent",
            disabled && "opacity-50 cursor-not-allowed",
          )}
          aria-label="No background effect"
          aria-pressed={isSelected("none")}
        >
          <Cancel01Icon className="w-6 h-6 mb-1 text-[var(--chalk-muted-text)]" />
          <span className="text-[10px] font-medium text-[var(--chalk-text)]">None</span>
        </ChalkButton>

        {effects.map((effect) => (
          <ChalkButton
            variant="outline"
            key={effect.id}
            type="button"
            onClick={() => onSelect(effect.id)}
            disabled={disabled}
            className={cn(
              "!relative !min-h-0 !aspect-video !rounded-md !border-2 !p-0 overflow-hidden flex flex-col items-center justify-center transition-all",
              "bg-[var(--chalk-stage)] hover:bg-[var(--chalk-stage)]",
              isSelected(effect.id) ? "border-[var(--chalk-accent)] ring-1 ring-[var(--chalk-focus)] ring-offset-1 ring-offset-[var(--chalk-canvas)]" : "border-transparent",
              disabled && "opacity-50 cursor-not-allowed",
            )}
            aria-label={`Select ${effect.name}`}
            aria-pressed={isSelected(effect.id)}
          >
            {effect.type === "blur" ? (
              <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-500 to-slate-600">
                <Image01Icon className="w-6 h-6 text-[var(--chalk-accent-text)] mb-1 opacity-50 blur-[1px]" />
                <span className="text-[10px] font-medium text-[var(--chalk-accent-text)] drop-shadow-sm">Blur</span>
              </div>
            ) : effect.thumbnail || effect.value ? (
              <img src={effect.thumbnail || effect.value} alt={effect.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-[var(--chalk-stage)]">
                <Image01Icon className="w-6 h-6 text-[var(--chalk-muted-text)]" />
              </div>
            )}
          </ChalkButton>
        ))}

        {onCustomUpload && (
          <ChalkButton
            variant="outline"
            type="button"
            onClick={handleUploadClick}
            disabled={disabled}
            className={cn(
              "!relative !min-h-0 !aspect-video !rounded-md !border-2 !border-dashed !p-0 overflow-hidden flex flex-col items-center justify-center transition-all",
              "border-[var(--chalk-line)]",
              "hover:bg-[var(--chalk-stage)] hover:border-[var(--chalk-line)]",
              disabled && "opacity-50 cursor-not-allowed",
            )}
            aria-label="Upload custom background"
          >
            <Upload01Icon className="w-5 h-5 mb-1 text-[var(--chalk-muted-text)]" />
            <span className="text-[10px] font-medium text-[var(--chalk-muted-text)]">Upload</span>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} disabled={disabled} tabIndex={-1} />
          </ChalkButton>
        )}
      </div>
    </div>
  );
});

BackgroundEffectsPicker.displayName = "BackgroundEffectsPicker";
