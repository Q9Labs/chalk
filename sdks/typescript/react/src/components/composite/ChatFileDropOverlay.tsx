import { CHALK_CHAT_ATTACHMENT_LIMITS } from "@q9labsai/chalk-client";
import React from "react";
import { Upload01Icon } from "../../utils/icons";

export function ChatFileDropOverlay(): React.JSX.Element {
  return (
    <div className="call-file-drop-overlay" data-part="chat-file-drop-overlay">
      <div className="call-file-drop-zone">
        <div className="call-file-drop-icon" aria-hidden="true">
          <Upload01Icon className="h-5 w-5" />
        </div>
        <h3>Drop files to send</h3>
        <p>Up to {CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files, 25 MB each</p>
      </div>
    </div>
  );
}
