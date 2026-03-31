import type React from "react";
import { useState, useCallback, useRef, useEffect } from "react";

import { Edit02Icon, Tick01Icon, Cancel01Icon } from "../../../utils/icons";
import { useHaptics } from "../../../hooks/ui/useHaptics";
import { cn } from "../../../utils/cn";

interface PreJoinMobileJoinSheetProps {
  displayName: string;
  isLoading: boolean;
  onDisplayNameChange: (value: string) => void;
  onJoin: (displayNameOverride?: string) => void;
}

export function PreJoinMobileJoinSheet({
  displayName,
  isLoading,
  onDisplayNameChange,
  onJoin,
}: PreJoinMobileJoinSheetProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmedDisplayName = displayName.trim();
  const trimmedEditValue = editValue.trim();
  const effectiveDisplayName = isEditing ? trimmedEditValue : trimmedDisplayName;
  const canJoinWithPendingName = effectiveDisplayName.length > 0;
  const { trigger } = useHaptics({ enabled: canJoinWithPendingName && !isLoading });

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = useCallback(() => {
    setEditValue(displayName);
    setIsEditing(true);
  }, [displayName]);

  const handleSave = useCallback(() => {
    if (editValue.trim()) {
      onDisplayNameChange(editValue.trim());
    }
    setIsEditing(false);
  }, [editValue, onDisplayNameChange]);

  const handleCancel = useCallback(() => {
    setEditValue(displayName);
    setIsEditing(false);
  }, [displayName]);

  const handleJoinClick = useCallback(() => {
    if (isEditing) {
      if (!trimmedEditValue) {
        return;
      }
      onDisplayNameChange(trimmedEditValue);
      setIsEditing(false);
      void trigger("success");
      onJoin(trimmedEditValue);
      return;
    }

    void trigger("success");
    onJoin();
  }, [isEditing, onDisplayNameChange, onJoin, trigger, trimmedEditValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleSave();
      } else if (e.key === "Escape") {
        handleCancel();
      }
    },
    [handleSave, handleCancel]
  );

  return (
    <div
      className={cn(
        "w-full bg-gradient-to-t from-black/90 via-black/70 to-transparent",
        "pt-10 pb-[max(24px,env(safe-area-inset-bottom))] px-5"
      )}
    >
      <div className="flex flex-col gap-5 pb-2">
        {isEditing ? (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Your name"
              disabled={isLoading}
              className={cn(
                "flex-1 h-12 px-4 rounded-xl text-base transition-all outline-none",
                "text-white placeholder:text-white/50 disabled:opacity-50",
                "border border-white/20 bg-white/10",
                "focus-visible:border-white/40 focus-visible:bg-white/15"
              )}
            />
            <button
              type="button"
              onClick={handleSave}
              className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center",
                "bg-white/20 text-white hover:bg-white/30 transition-colors"
              )}
            >
              <Tick01Icon size={20} />
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center",
                "bg-white/10 text-white/70 hover:bg-white/20 transition-colors"
              )}
            >
              <Cancel01Icon size={20} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleStartEdit}
            disabled={isLoading}
            className={cn(
              "w-full flex items-center justify-between h-12 px-4 rounded-xl",
              "bg-white/10 border border-white/20 text-white",
              "hover:bg-white/15 transition-colors disabled:opacity-50"
            )}
          >
            <span className="font-medium">{displayName || "Your name"}</span>
            <Edit02Icon size={18} className="text-white/60" />
          </button>
        )}

        <button
          type="button"
          onClick={handleJoinClick}
          disabled={!canJoinWithPendingName || isLoading}
          className={cn(
            "relative w-full h-14 rounded-full font-semibold text-base text-white",
            "transition-all duration-200 active:scale-[0.97]",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center justify-center gap-2 overflow-hidden",
            "outline-none focus-visible:ring-4 focus-visible:ring-white/30"
          )}
          style={{ backgroundColor: "var(--primary)" }}
        >
          <span className="relative z-10 flex items-center gap-2">
            {isLoading ? (
              <>
                <svg
                  className="animate-spin h-5 w-5"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Joining...
              </>
            ) : (
              "Ask to join"
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
