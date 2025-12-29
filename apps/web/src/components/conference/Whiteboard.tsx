import { Excalidraw } from "@excalidraw/excalidraw";
import { Button } from "@q9labs/chalk-ui";
import { X } from "lucide-react";

interface WhiteboardProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Whiteboard({ isOpen, onClose }: WhiteboardProps) {
  if (!isOpen) return null;

  return (
    <div className="absolute inset-0 z-50 bg-background flex flex-col">
      <div className="h-14 border-b flex items-center justify-between px-4 bg-background">
        <h2 className="font-semibold text-lg text-foreground">Whiteboard</h2>
        <Button variant="ghost" size="icon" onClick={onClose} type="button">
          <X className="h-5 w-5" />
        </Button>
      </div>
      <div className="flex-1 w-full h-full">
        <Excalidraw
          theme="light"
          initialData={{
            appState: {
              viewBackgroundColor: "#ffffff",
            },
          }}
        />
      </div>
    </div>
  );
}
