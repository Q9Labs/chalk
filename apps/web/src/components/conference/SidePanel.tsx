import { Button, Input } from "@q9labs/chalk-ui";
import { MessageSquare, X, Send, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useChat, useParticipants } from "@q9labs/chalk-react";
import { twMerge } from "tailwind-merge";

interface SidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: 'chat' | 'participants';
  onTabChange: (tab: 'chat' | 'participants') => void;
}

export function SidePanel({ isOpen, onClose, activeTab, onTabChange }: SidePanelProps) {
  if (!isOpen) return null;

  return (
    <div className="flex flex-col h-full w-80 bg-background border-l border-border shadow-xl animate-in slide-in-from-right duration-300">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex bg-muted/50 p-1 rounded-lg">
          <button
            type="button"
            onClick={() => onTabChange('participants')}
            className={twMerge(
              "px-3 py-1.5 text-sm font-medium rounded-md transition-all",
              activeTab === 'participants' 
                ? "bg-background text-foreground shadow-sm" 
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Participants
          </button>
          <button
            type="button"
            onClick={() => onTabChange('chat')}
            className={twMerge(
              "px-3 py-1.5 text-sm font-medium rounded-md transition-all",
              activeTab === 'chat' 
                ? "bg-background text-foreground shadow-sm" 
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Chat
          </button>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'participants' ? <ParticipantsList /> : <ChatBox />}
      </div>
    </div>
  );
}

function ParticipantsList() {
  const { participants, localParticipant } = useParticipants();
  const allParticipants = localParticipant 
    ? [localParticipant, ...participants.filter(p => !p.isLocal)]
    : participants;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border bg-muted/20">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {allParticipants.length} In Meeting
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {allParticipants.map((p) => (
          <div key={p.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors group">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium text-sm">
                {p.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium truncate max-w-[120px]">
                  {p.displayName} {p.isLocal && "(You)"}
                </span>
                <span className="text-[10px] text-muted-foreground capitalize">
                  {p.isLocal ? "Host" : "Participant"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              {p.audioEnabled ? (
                <Mic className="h-4 w-4" />
              ) : (
                <MicOff className="h-4 w-4 text-destructive/70" />
              )}
              {p.videoEnabled ? (
                <Video className="h-4 w-4" />
              ) : (
                <VideoOff className="h-4 w-4 text-destructive/70" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChatBox() {
  const { messages, sendMessage } = useChat();
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    
    sendMessage(inputValue.trim());
    setInputValue("");
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-center p-4">
            <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm">No messages yet.</p>
            <p className="text-xs">Start the conversation!</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={`${msg.timestamp}-${msg.senderId}`} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-foreground/80">{msg.senderName}</span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-muted text-sm text-foreground break-words">
                {msg.content}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-border bg-background">
        <form onSubmit={handleSend} className="relative">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Type a message..."
            className="pr-10"
          />
          <Button 
            type="submit" 
            size="icon" 
            variant="ghost" 
            className="absolute right-1 top-1 h-8 w-8 text-primary hover:text-primary/80 hover:bg-transparent"
            disabled={!inputValue.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
