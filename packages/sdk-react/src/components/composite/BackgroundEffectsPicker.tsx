import React, { useMemo, useRef } from 'react';
import { Cancel01Icon, Upload01Icon, Image01Icon } from '../../utils/icons';
import { cn } from '../../utils/cn';
import { getParticipantThemeVariables } from '../../utils/colorGenerator';

export interface BackgroundEffect {
  id: string;
  type: 'none' | 'blur' | 'image';
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
  className?: string;
}

export const BackgroundEffectsPicker = React.memo(({
  effects,
  selectedEffectId,
  onSelect,
  onCustomUpload,
  disabled = false,
  participantColorSeed,
  className
}: BackgroundEffectsPickerProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onCustomUpload) {
      onCustomUpload(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const isSelected = (id: string) =>
    selectedEffectId === id || (id === 'none' && !selectedEffectId && !effects.find(e => e.id === selectedEffectId));

  return (
    <div className={cn("flex flex-col gap-3", className)} style={themeVariables as React.CSSProperties}>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-muted-foreground">
          Background Effects
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label="Background effects">
        <button
          type="button"
          onClick={() => onSelect('none')}
          disabled={disabled}
          className={cn(
            "relative aspect-video rounded-md border-2 overflow-hidden flex flex-col items-center justify-center transition-all",
            "bg-secondary hover:bg-accent",
            isSelected('none')
              ? "border-primary ring-1 ring-ring ring-offset-1 ring-offset-background"
              : "border-transparent",
            disabled && "opacity-50 cursor-not-allowed"
          )}
          aria-label="No background effect"
          aria-pressed={isSelected('none')}
        >
          <Cancel01Icon className="w-6 h-6 mb-1 text-muted-foreground" />
          <span className="text-[10px] font-medium text-muted-foreground">None</span>
        </button>

        {effects.map((effect) => (
          <button
            key={effect.id}
            type="button"
            onClick={() => onSelect(effect.id)}
            disabled={disabled}
            className={cn(
              "relative aspect-video rounded-md border-2 overflow-hidden flex flex-col items-center justify-center transition-all",
              "bg-secondary hover:bg-accent",
              isSelected(effect.id)
                ? "border-primary ring-1 ring-ring ring-offset-1 ring-offset-background"
                : "border-transparent",
              disabled && "opacity-50 cursor-not-allowed"
            )}
            aria-label={`Select ${effect.name}`}
            aria-pressed={isSelected(effect.id)}
          >
            {effect.type === 'blur' ? (
              <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-300 to-gray-400">
                <Image01Icon className="w-6 h-6 text-white mb-1 opacity-50 blur-[1px]" />
                <span className="text-[10px] font-medium text-white drop-shadow-md">Blur</span>
              </div>
            ) : effect.thumbnail || effect.value ? (
              <img
                src={effect.thumbnail || effect.value}
                alt={effect.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-accent">
                <Image01Icon className="w-6 h-6 text-muted-foreground" />
              </div>
            )}
          </button>
        ))}

        {onCustomUpload && (
          <button
            type="button"
            onClick={handleUploadClick}
            disabled={disabled}
            className={cn(
              "relative aspect-video rounded-md border-2 border-dashed overflow-hidden flex flex-col items-center justify-center transition-all",
              "border-border",
              "hover:bg-secondary hover:border-muted-foreground",
              disabled && "opacity-50 cursor-not-allowed"
            )}
            aria-label="Upload custom background"
          >
            <Upload01Icon className="w-5 h-5 mb-1 text-muted-foreground" />
            <span className="text-[10px] font-medium text-muted-foreground">Upload</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
              disabled={disabled}
              tabIndex={-1}
            />
          </button>
        )}
      </div>
    </div>
  );
});

BackgroundEffectsPicker.displayName = 'BackgroundEffectsPicker';
