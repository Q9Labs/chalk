import { cn } from '../../utils/cn';
import { ControlBar } from './ControlBar';
import type { ControlBarButton } from './ControlBar';
import { X } from 'lucide-react';
import { IconButton } from '../atomic';

export interface MobileControlSheetProps {
  isOpen: boolean;
  onClose: () => void;
  
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isRecording?: boolean;
  isChatOpen?: boolean;
  isParticipantsOpen?: boolean;
  isTranscriptionEnabled?: boolean;
  isHandRaised?: boolean;
  
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onToggleScreenShare?: () => void;
  onToggleRecording?: () => void;
  onToggleChat?: () => void;
  onToggleParticipants?: () => void;
  onToggleTranscription?: () => void;
  onToggleHandRaise?: () => void;
  onOpenReactions?: () => void;
  onOpenSettings?: () => void;
  onOpenMore?: () => void;
  onLeave?: () => void;
  
  className?: string;
}

export const MobileControlSheet = ({
  isOpen,
  onClose,
  className,
  ...controlBarProps
}: MobileControlSheetProps) => {
  const buttons: ControlBarButton[] = [
    'mic', 'video', 'handraise', 'chat', 
    'participants', 'reactions', 'settings', 'leave'
  ];

  return (
    <>
      <div 
        className={cn(
          "fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity",
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />
      
      <div 
        className={cn(
          "fixed bottom-0 left-0 right-0 bg-background-primary rounded-t-xl z-50 p-4 transition-transform duration-300 ease-out",
          isOpen ? "translate-y-0" : "translate-y-full",
          className
        )}
      >
        <div className="w-12 h-1.5 bg-border rounded-full mx-auto mb-4" />
        
        <div className="flex justify-end mb-2">
            <IconButton icon={<X size={20} />} onClick={onClose} variant="ghost" aria-label="Close menu" />
        </div>

        <ControlBar
          {...controlBarProps}
          buttons={buttons}
          variant="minimal"
          className="grid grid-cols-4 gap-4"
          showLabels={true}
        />
      </div>
    </>
  );
};
