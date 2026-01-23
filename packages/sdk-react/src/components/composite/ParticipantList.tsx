import React, { useMemo, useState } from 'react';
import { Cancel01Icon, MoreVerticalIcon, Search01Icon, Microphone01Icon, MicrophoneOff01Icon, UserRemove01Icon, Crown01Icon, ArrowDown01Icon, ArrowUp01Icon, Shield01Icon, UserGroupIcon } from '../../utils/icons';
import {
  Avatar,
  AudioIndicator,
  HandRaiseIndicator,
  IconButton,
  Input,
  Badge
} from '../atomic';
import { Button } from '../ui';
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
  onMakeCoHost?: (id: string) => void;
  onAddPeople?: () => void;
  canManageParticipants?: boolean;
  searchable?: boolean;
  onClose?: () => void;
  className?: string;
  variant?: 'default' | 'sidebar' | 'mobile';
  title?: string;
}

export const ParticipantList = React.memo(({
  participants,
  onMuteParticipant,
  onRemoveParticipant,
  onMakeHost,
  onMakeCoHost,
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
        "group flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors relative",
        variant === 'sidebar' && "hover:bg-muted/50"
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="relative">
          <Avatar 
            name={participant.displayName}
            size="sm"
            className={cn(variant === 'sidebar' && "w-9 h-9")}
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
              "text-sm font-normal truncate",
              variant === 'sidebar' ? "text-card-foreground" : "text-chalk-text-primary"
            )}>
              {participant.displayName}
            </span>
            {participant.isLocal && (
              <span className={cn(
                "text-xs",
                variant === 'sidebar' ? "text-muted-foreground" : "text-chalk-text-muted"
              )}>(you)</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {participant.role && participant.role !== 'participant' && (
              <span className={cn(
                "text-[11px] tracking-normal font-normal",
                variant === 'sidebar'
                  ? "text-muted-foreground"
                  : "text-chalk-text-secondary bg-chalk-bg-subtle px-1.5 py-0.5 rounded"
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
            <div className="bg-[#dc2626]/20 p-1.5 rounded-full">
              <MicrophoneOff01Icon className="w-3.5 h-3.5 text-[#dc2626]" />
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
              icon={<MoreVerticalIcon className="w-4 h-4" />}
              size="sm"
              variant="ghost"
              className={cn(
                variant === 'sidebar'
                  ? "opacity-70 hover:opacity-100 text-muted-foreground hover:text-foreground"
                  : "opacity-0 group-hover:opacity-100 focus:opacity-100"
              )}
              onClick={() => setActiveMenuId(activeMenuId === participant.id ? null : participant.id)}
              aria-label={`Options for ${participant.displayName}`}
            />

            {activeMenuId === participant.id && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setActiveMenuId(null)}
                />
                <div className={cn(
                  "absolute right-0 top-full mt-1 w-48 rounded-lg shadow-xl z-20 overflow-hidden py-1",
                  variant === 'sidebar'
                    ? "bg-popover/95 backdrop-blur-xl border border-border/50"
                    : "bg-chalk-bg-surface border border-chalk-border-subtle"
                )}>
                  {onMuteParticipant && (
                    <button
                      onClick={() => {
                        onMuteParticipant(participant.id);
                        setActiveMenuId(null);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm flex items-center gap-2",
                        variant === 'sidebar'
                          ? "text-popover-foreground hover:bg-muted/50"
                          : "text-chalk-text-primary hover:bg-chalk-bg-subtle"
                      )}
                    >
                      {participant.isMuted ? <Microphone01Icon className="w-4 h-4" /> : <MicrophoneOff01Icon className="w-4 h-4" />}
                      {participant.isMuted ? "Unmute" : "Mute"}
                    </button>
                  )}

                  {onMakeHost && participant.role !== 'host' && (
                    <button
                      onClick={() => {
                        onMakeHost(participant.id);
                        setActiveMenuId(null);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm flex items-center gap-2",
                        variant === 'sidebar'
                          ? "text-popover-foreground hover:bg-muted/50"
                          : "text-chalk-text-primary hover:bg-chalk-bg-subtle"
                      )}
                    >
                      <Crown01Icon className="w-4 h-4" />
                      Make Host
                    </button>
                  )}

                  {onMakeCoHost && participant.role === 'participant' && (
                    <button
                      onClick={() => {
                        onMakeCoHost(participant.id);
                        setActiveMenuId(null);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm flex items-center gap-2",
                        variant === 'sidebar'
                          ? "text-popover-foreground hover:bg-muted/50"
                          : "text-chalk-text-primary hover:bg-chalk-bg-subtle"
                      )}
                    >
                      <Shield01Icon className="w-4 h-4" />
                      Make Co-Host
                    </button>
                  )}

                  {onRemoveParticipant && (
                    <button
                      onClick={() => {
                        onRemoveParticipant(participant.id);
                        setActiveMenuId(null);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm flex items-center gap-2",
                        variant === 'sidebar'
                          ? "text-[#dc2626] hover:bg-[#dc2626]/10"
                          : "text-chalk-error-main hover:bg-chalk-error-subtle"
                      )}
                    >
                      <UserRemove01Icon className="w-4 h-4" />
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

  // Mobile variant - fills container, no header (MobilePanel provides it)
  if (variant === 'mobile') {
    return (
      <div
        className={cn(
          "flex flex-col h-full w-full overflow-hidden font-sans relative bg-card",
          className
        )}
        data-tour="participants-panel"
        role="complementary"
        aria-label="Participants list"
      >
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {onAddPeople && (
            <Button
              onClick={onAddPeople}
              className="w-full bg-[#1bb6a6] hover:bg-[#0d9488] text-white rounded-full py-3 px-4 mb-4 shadow-lg shadow-[#1bb6a6]/25 min-h-[48px]"
            >
              <UserGroupIcon className="w-4 h-4" />
              <span>Add people</span>
            </Button>
          )}

          {/* Section Label */}
          <div className="mb-3 px-1">
            <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-semibold">
              IN THE MEETING ({participants.length})
            </p>
          </div>

          {/* Participants List */}
          <div className="space-y-1">
            {filteredParticipants.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No participants found
              </div>
            ) : (
              filteredParticipants.map(renderParticipantRow)
            )}
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'sidebar') {
    return (
      <div
        className={cn(
          "flex flex-col h-full w-full overflow-hidden font-sans relative bg-transparent",
          !prefersReducedMotion && "chalk-animate-slide-right",
          className
        )}
        data-tour="participants-panel"
        role="complementary"
        aria-label="Participants list"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-5">
          <h2 className="text-2xl font-bold text-card-foreground tracking-tight">{title === 'Participants' ? 'People' : title}</h2>
          {onClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors p-1"
              aria-label="Close"
            >
              <Cancel01Icon className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {onAddPeople && (
            <Button
              onClick={onAddPeople}
              className="w-full bg-[#1bb6a6] hover:bg-[#0d9488] text-white rounded-full py-3 px-4 mb-6 shadow-lg shadow-[#1bb6a6]/25"
            >
              <UserGroupIcon className="w-4 h-4" />
              <span>Add people</span>
            </Button>
          )}

          {/* Section Label */}
          <div className="mb-3 px-1">
            <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-semibold">
              IN THE MEETING
            </p>
          </div>

          {/* Participants Container with Glass Effect */}
          <div className="rounded-2xl overflow-hidden bg-muted/30 backdrop-blur-sm border border-border/30">
            {/* Collapsible Header */}
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="w-full px-4 py-3.5 flex items-center justify-between group focus:outline-none cursor-pointer hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-card-foreground font-semibold text-sm">Participants</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-sm font-medium">
                  {participants.length}
                </span>
                {isExpanded ? (
                  <ArrowUp01Icon className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ArrowDown01Icon className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
            </button>

            {/* Participants List */}
            {isExpanded && (
              <div className="px-3 pb-3">
                {filteredParticipants.length === 0 ? (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    No participants found
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredParticipants.map(renderParticipantRow)}
                  </div>
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
            icon={<Cancel01Icon className="w-4 h-4" />} 
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
            icon={<Search01Icon className="w-4 h-4" />}
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
