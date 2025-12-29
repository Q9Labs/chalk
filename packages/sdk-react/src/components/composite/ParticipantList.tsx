import { useMemo, useState } from 'react';
import { X, MoreVertical, Search, Mic, MicOff, UserX, Crown } from 'lucide-react';
import { 
  Avatar, 
  AudioIndicator, 
  HandRaiseIndicator, 
  IconButton,
  Input,
  Badge
} from '../atomic';
import { cn } from '../../utils/cn';

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
  canManageParticipants?: boolean;
  searchable?: boolean;
  onClose?: () => void;
  className?: string;
}

export function ParticipantList({
  participants,
  onMuteParticipant,
  onRemoveParticipant,
  onMakeHost,
  canManageParticipants = false,
  searchable = true,
  onClose,
  className
}: ParticipantListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

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

  return (
    <div 
      className={cn(
        "flex flex-col h-full bg-chalk-bg-surface border-l border-chalk-border-subtle w-80 shadow-xl chalk-animate-slide-right",
        className
      )}
      data-tour="participants-panel"
      role="complementary"
      aria-label="Participants list"
    >
      <div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-chalk-text-primary">Participants</h2>
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
          filteredParticipants.map((participant) => (
            <div 
              key={participant.id}
              className="group flex items-center justify-between p-2 rounded-md hover:bg-chalk-bg-subtle transition-colors relative"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative">
                  <Avatar 
                    src={participant.avatarUrl} 
                    name={participant.displayName}
                    size="sm"
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
                    <span className="text-sm font-medium text-chalk-text-primary truncate">
                      {participant.displayName}
                    </span>
                    {participant.isLocal && (
                      <span className="text-xs text-chalk-text-muted">(You)</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {participant.role && participant.role !== 'participant' && (
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-chalk-text-secondary bg-chalk-bg-subtle px-1.5 py-0.5 rounded">
                        {participant.role}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <AudioIndicator 
                  muted={participant.isMuted} 
                  level={participant.isMuted ? 0 : 0.5}
                  className={cn(participant.isMuted && "text-chalk-error-main")}
                />
                
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
          ))
        )}
      </div>
    </div>
  );
}
