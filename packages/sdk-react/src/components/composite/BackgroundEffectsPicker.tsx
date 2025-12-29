import React, { useRef } from 'react';
import { Ban, Upload, Image as ImageIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

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
  className?: string;
}

export function BackgroundEffectsPicker({
  effects,
  selectedEffectId,
  onSelect,
  onCustomUpload,
  disabled = false,
  className
}: BackgroundEffectsPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-chalk-text-secondary">
          Background Effects
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => onSelect('none')}
          disabled={disabled}
          className={cn(
            "relative aspect-video rounded-md border-2 overflow-hidden flex flex-col items-center justify-center transition-all bg-chalk-bg-subtle hover:bg-chalk-bg-tertiary",
            selectedEffectId === 'none' || (!selectedEffectId && !effects.find(e => e.id === selectedEffectId))
              ? "border-chalk-accent ring-1 ring-chalk-accent ring-offset-1 ring-offset-chalk-bg-surface" 
              : "border-transparent",
            disabled && "opacity-50 cursor-not-allowed"
          )}
          aria-label="No background effect"
          aria-pressed={selectedEffectId === 'none'}
        >
          <Ban className="w-6 h-6 text-chalk-text-secondary mb-1" />
          <span className="text-[10px] font-medium text-chalk-text-secondary">None</span>
        </button>

        {effects.map((effect) => (
          <button
            key={effect.id}
            type="button"
            onClick={() => onSelect(effect.id)}
            disabled={disabled}
            className={cn(
              "relative aspect-video rounded-md border-2 overflow-hidden flex flex-col items-center justify-center transition-all bg-chalk-bg-subtle hover:bg-chalk-bg-tertiary",
              selectedEffectId === effect.id
                ? "border-chalk-accent ring-1 ring-chalk-accent ring-offset-1 ring-offset-chalk-bg-surface" 
                : "border-transparent",
              disabled && "opacity-50 cursor-not-allowed"
            )}
            aria-label={`Select ${effect.name}`}
            aria-pressed={selectedEffectId === effect.id}
          >
            {effect.type === 'blur' ? (
              <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-300 to-gray-400">
                 <ImageIcon className="w-6 h-6 text-white mb-1 opacity-50 blur-[1px]" />
                 <span className="text-[10px] font-medium text-white drop-shadow-md">Blur</span>
              </div>
            ) : effect.thumbnail || effect.value ? (
              <img 
                src={effect.thumbnail || effect.value} 
                alt={effect.name} 
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-chalk-bg-tertiary">
                <ImageIcon className="w-6 h-6 text-chalk-text-muted" />
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
              "relative aspect-video rounded-md border-2 border-dashed border-chalk-border-color overflow-hidden flex flex-col items-center justify-center transition-all hover:bg-chalk-bg-subtle hover:border-chalk-text-secondary",
              disabled && "opacity-50 cursor-not-allowed"
            )}
            aria-label="Upload custom background"
          >
            <Upload className="w-5 h-5 text-chalk-text-secondary mb-1" />
            <span className="text-[10px] font-medium text-chalk-text-secondary">Upload</span>
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
}
