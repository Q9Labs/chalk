import { useChalk } from "@q9labs/chalk-react";
import { Button } from "@q9labs/chalk-ui";
import { Smile } from "lucide-react";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type ReactionEmoji = "👍" | "👎" | "❤️" | "🎉" | "😂" | "😮" | "😢" | "🤔";

const AVAILABLE_REACTIONS: ReactionEmoji[] = ["👍", "👎", "❤️", "🎉", "😂", "😮", "😢", "🤔"];

interface FloatingReaction {
  id: string;
  emoji: string;
  x: number;
  y: number;
}

export function ReactionsOverlay() {
  const { room } = useChalk();
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    if (!room) return;

    const handleReaction = (data: { emoji: string; participantId: string }) => {
      const id = Math.random().toString(36).substring(7);
      const x = Math.random() * 80 + 10;
      
      setReactions((prev) => [...prev, { id, emoji: data.emoji, x, y: 80 }]);

      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== id));
      }, 2000);
    };

    const unsub = room.on("reaction", handleReaction);

    return () => {
      unsub();
    };
  }, [room]);

  const sendReaction = (emoji: ReactionEmoji) => {
    if (room) {
      room.sendReaction(emoji);
      
      const id = Math.random().toString(36).substring(7);
      setReactions((prev) => [...prev, { id, emoji, x: 50, y: 80 }]);
      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== id));
      }, 2000);
      
      setShowPicker(false);
    }
  };

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-40">
      <AnimatePresence>
        {reactions.map((reaction) => (
          <motion.div
            key={reaction.id}
            initial={{ opacity: 0, y: 100, scale: 0.5 }}
            animate={{ opacity: 1, y: -200, scale: 1.5 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2, ease: "easeOut" }}
            style={{
              position: "absolute",
              left: `${reaction.x}%`,
              bottom: "10%",
              fontSize: "3rem",
            }}
          >
            {reaction.emoji}
          </motion.div>
        ))}
      </AnimatePresence>

      <div className="absolute bottom-24 right-6 pointer-events-auto">
        <div className="relative">
          <AnimatePresence>
            {showPicker && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.8, y: 10 }}
                className="absolute bottom-full right-0 mb-4 p-2 bg-[#202124] border border-white/10 rounded-full shadow-xl flex gap-1 backdrop-blur-md"
              >
                {AVAILABLE_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => sendReaction(emoji)}
                    className="w-10 h-10 flex items-center justify-center text-2xl hover:bg-white/10 rounded-full transition-colors active:scale-90"
                  >
                    {emoji}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <Button
            size="icon"
            variant="ghost"
            type="button"
            className={`w-12 h-12 rounded-full shadow-lg transition-colors ${showPicker ? "bg-[#8ab4f8] text-black" : "bg-[#3c4043] text-white hover:bg-[#43474b]"}`}
            onClick={() => setShowPicker(!showPicker)}
          >
            <Smile className="w-6 h-6" />
          </Button>
        </div>
      </div>
    </div>
  );
}
