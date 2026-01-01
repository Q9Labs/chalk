import React, { useMemo, useState } from 'react';
import { X, MoreVertical, Search, Mic, MicOff, UserX, Crown, UserPlus, ChevronDown, ChevronUp } from 'lucide-react';
import { 
  Avatar, 
  AudioIndicator, 
  HandRaiseIndicator, 
  IconButton,
  Input,
  Badge
} from '../atomic';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface Participant {
  id: string;
  displayName: string;
  isLocal?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isHandRaised?: boolean;
  role?: 'host' | 'co-host' | 'participant';
  avatarUrl?: string;
}

export interface ParticipantListProps {
  participants: Participant[];
  onMuteParticipant?: (id: string) => void;
  onRemoveParticipant?: (id: string) => void;
  onMakeHost?: (id: string) => void;
  onAddPeople?: () => void;
  canManageParticipants?: boolean;
  searchable?: boolean;
  onClose?: () => void;
  className?: string;
  variant?: 'default' | 'sidebar';
  title?: string;
}

export const ParticipantList = React.memo(({
  participants,
  onMuteParticipant,
  onRemoveParticipant,
  onMakeHost,
  onAddPeople,
  canManageParticipants = false,
  searchable = true,
  onClose,
  className,
  variant = 'default',
  title = 'Participants'
}: ParticipantListProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  const filteredParticipants = useMemo(() => {
    let sorted = [...participants].sort((a, b) => {
      const aScore = a.role === 'host' ? 2 : a.role === 'co-host' ? 1 : 0;
      const bScore = b.role === 'host' ? 2 : b.role === 'co-host' ? 1 : 0;
      
      if (aScore !== bScore) return bScore - aScore;
      
      if (a.isLocal) return -1;
      if (b.isLocal) return 1;
      
      return a.displayName.localeCompare(b.displayName);
    });

    if (searchQuery) {
      sorted = sorted.filter(p => 
        p.displayName.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    
    return sorted;
  }, [participants, searchQuery]);

  const renderParticipantRow = (participant: Participant) => (
    <div 
      key={participant.id}
      className={cn(
        "group flex items-center justify-between p-2 rounded-md hover:bg-chalk-bg-subtle transition-colors relative",
        variant === 'sidebar' && "rounded-xl hover:bg-white/5"
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="relative">
          <Avatar 
            src={participant.avatarUrl} 
            name={participant.displayName}
            size="sm"
            className={cn(variant === 'sidebar' && "border border-white/10")}
          />
          {participant.isHandRaised && (
            <HandRaiseIndicator 
              raised={true} 
              size="sm"
              className="-top-1 -right-1"
            />
          )}
        </div>
        
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={cn(
              "text-sm font-medium truncate",
              variant === 'sidebar' ? "text-gray-200" : "text-chalk-text-primary"
            )}>
              {participant.displayName}
            </span>
            {participant.isLocal && (
              <span className={cn(
                "text-xs",
                variant === 'sidebar' ? "text-gray-500" : "text-chalk-text-muted"
              )}>(You)</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {participant.role && participant.role !== 'participant' && (
              <span className={cn(
                "text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded",
                variant === 'sidebar' 
                  ? "text-gray-500 bg-transparent p-0" 
                  : "text-chalk-text-secondary bg-chalk-bg-subtle"
              )}>
                {variant === 'sidebar' && participant.role === 'host' ? 'Meeting Host' : participant.role}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {variant === 'sidebar' ? (
          participant.isMuted ? (
            <div className="bg-red-500/20 p-1.5 rounded-full">
              <MicOff className="w-3.5 h-3.5 text-red-500" />
            </div>
          ) : null
        ) : (
          <AudioIndicator 
            muted={participant.isMuted} 
            level={participant.isMuted ? 0 : 0.5}
            className={cn(participant.isMuted && "text-chalk-error-main")}
          />
        )}
        
        {canManageParticipants && !participant.isLocal && (
          <div className="relative">
            <IconButton
              icon={<MoreVertical className="w-4 h-4" />}
              size="sm"
              variant="ghost"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100"
              onClick={() => setActiveMenuId(activeMenuId === participant.id ? null : participant.id)}
              aria-label={`Options for ${participant.displayName}`}
            />
            
            {activeMenuId === participant.id && (
              <>
                <div 
                  className="fixed inset-0 z-10" 
                  onClick={() => setActiveMenuId(null)}
                />
                <div className="absolute right-0 top-full mt-1 w-48 bg-chalk-bg-surface border border-chalk-border-subtle rounded-lg shadow-lg z-20 overflow-hidden py-1">
                  {onMuteParticipant && (
                    <button
                      onClick={() => {
                        onMuteParticipant(participant.id);
                        setActiveMenuId(null);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-chalk-text-primary hover:bg-chalk-bg-subtle flex items-center gap-2"
                    >
                      {participant.isMuted ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                      {participant.isMuted ? "Unmute" : "Mute"}
                    </button>
                  )}
                  
                  {onMakeHost && participant.role !== 'host' && (
                    <button
                      onClick={() => {
                        onMakeHost(participant.id);
                        setActiveMenuId(null);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-chalk-text-primary hover:bg-chalk-bg-subtle flex items-center gap-2"
                    >
                      <Crown className="w-4 h-4" />
                      Make Host
                    </button>
                  )}
                  
                  {onRemoveParticipant && (
                    <button
                      onClick={() => {
                        onRemoveParticipant(participant.id);
                        setActiveMenuId(null);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-chalk-error-main hover:bg-chalk-error-subtle flex items-center gap-2"
                    >
                      <UserX className="w-4 h-4" />
                      Remove
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === 'sidebar') {
    return (
      <div 
        className={cn(
          "flex flex-col h-full w-full bg-[#1E1E1E] rounded-[24px] overflow-hidden font-sans",
          !prefersReducedMotion && "chalk-animate-slide-right",
          className
        )}
        data-tour="participants-panel"
        role="complementary"
        aria-label="Participants list"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-4">
          <h2 className="text-xl font-bold text-white">{title === 'Participants' ? 'People' : title}</h2>
          {onClose && (
            <IconButton 
              icon={<X className="w-5 h-5" />} 
              size="sm" 
              variant="ghost" 
              onClick={onClose}
              className="text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close"
            />
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {onAddPeople && (
            <button
              onClick={onAddPeople}
              className="w-full bg-[#6E00E6] hover:bg-[#5a00bd] text-white rounded-full py-3 px-4 flex items-center justify-center gap-2 transition-all shadow-lg shadow-purple-900/20 mb-8 font-medium text-sm"
            >
              <UserPlus className="w-4 h-4" />
              <span>Add people</span>
            </button>
          )}

          {/* Section Header */}
          <div className="mb-3">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold pl-1">
              IN THE MEETING
            </p>
          </div>

          {/* Participants List Container */}
          <div className="bg-[#2B2B2B] rounded-2xl overflow-hidden">
            {/* Collapsible Header */}
            <button 
              onClick={() => setIsExpanded(!isExpanded)}
              className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
            >
              <span className="text-sm font-medium text-gray-200">Participants</span>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-400">{participants.length}</span>
                {isExpanded ? (
                  <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
              </div>
            </button>

            {/* List */}
            {isExpanded && (
              <div className="px-2 pb-2">
                {filteredParticipants.length === 0 ? (
                  <div className="p-8 text-center text-sm text-gray-500">
                    No participants found
                  </div>
                ) : (
                  filteredParticipants.map(renderParticipantRow)
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Default rendering (preserving exact existing structure/classes)
  return (
    <div 
      className={cn(
        "flex flex-col h-full bg-chalk-bg-surface border-l border-chalk-border-subtle w-80 shadow-xl",
        !prefersReducedMotion && "chalk-animate-slide-right",
        className
      )}
      data-tour="participants-panel"
      role="complementary"
      aria-label="Participants list"
    >
      <div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-chalk-text-primary">{title}</h2>
          <Badge variant="default" count={participants.length} />
        </div>
        {onClose && (
          <IconButton 
            icon={<X className="w-4 h-4" />} 
            size="sm" 
            variant="ghost" 
            onClick={onClose}
            aria-label="Close participant list"
          />
        )}
      </div>

      {searchable && (
        <div className="p-4 pb-2">
          <Input
            placeholder="Search participants..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            icon={<Search className="w-4 h-4" />}
            iconPosition="left"
            className="w-full"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredParticipants.length === 0 ? (
          <div className="p-8 text-center text-sm text-chalk-text-muted">
            No participants found
          </div>
        ) : (
          filteredParticipants.map(renderParticipantRow)
        )}
      </div>
    </div>
  );
});

ParticipantList.displayName = 'ParticipantList';
